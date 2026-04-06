import { NextResponse } from 'next/server';
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { Article } from '@/lib/geminiProcessor'; // Need to make sure this is accessible

// Need to define the API key loading logic on the server
function getApiKeys(): string[] {
  const defaultApiKeyStr = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";
  const customApiKeysStr = process.env.CUSTOM_GEMINI_API_KEYS || process.env.NEXT_PUBLIC_CUSTOM_GEMINI_API_KEYS || "";
  
  console.log("DEBUG: GEMINI_API_KEY set:", !!process.env.GEMINI_API_KEY);
  console.log("DEBUG: NEXT_PUBLIC_GEMINI_API_KEY set:", !!process.env.NEXT_PUBLIC_GEMINI_API_KEY);
  
  let apiKeys: string[] = [];
  
  if (customApiKeysStr) {
    const customKeys = customApiKeysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
    apiKeys = [...apiKeys, ...customKeys];
  }
  
  if (defaultApiKeyStr) {
    const defaultKeys = defaultApiKeyStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
    const uniqueDefaultKeys = defaultKeys.filter(k => !apiKeys.includes(k));
    apiKeys = [...apiKeys, ...uniqueDefaultKeys];
  }

  if (apiKeys.length === 0) {
    throw new Error("No valid API keys found.");
  }
  return apiKeys;
}

export async function POST(req: Request) {
  try {
    const { optimizedZones, pageNumber, fileName, base64Image } = await req.json();
    const apiKeys = getApiKeys();

    const jsonPayload = JSON.stringify(optimizedZones);
    
    const prompt = `
    Bạn là chuyên gia biên tập báo chí. Nhiệm vụ: Trích xuất nội dung bài báo từ JSON zones.
    
    QUY TẮC BẮT BUỘC:
    1. Chỉ trả về JSON thuần túy theo schema. KHÔNG chào hỏi, KHÔNG giải thích, KHÔNG thêm văn bản thừa.
    2. Gộp Sapo/Tít phụ vào Content.
    3. Loại bỏ Header/Footer.
    4. Giữ nguyên tiêu đề.
    5. Trích xuất ĐẦY ĐỦ 100% văn bản.
    6. Tìm chỉ dẫn chuyển trang (ví dụ: "(Xem tiếp trang 5)") đưa vào trường 'sp'.
    7. Tìm Dropcap và ghép vào từ đầu tiên.
    
    DỮ LIỆU ZONES (JSON):
    ${jsonPayload}
    `;

    const contents: any[] = [];
    if (base64Image) {
      const base64Data = base64Image.split(',')[1] || base64Image;
      contents.push({
        parts: [
          { inlineData: { data: base64Data, mimeType: "image/png" } },
          { text: prompt }
        ]
      });
    } else {
      contents.push({ parts: [{ text: prompt }] });
    }

    const modelsToTry = [
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3.1-pro-preview"
    ];

    let finalArticles: any[] = [];
    let success = false;

    for (const apiKey of apiKeys) {
      for (const model of modelsToTry) {
        const ai = new GoogleGenAI({ apiKey });
        try {
          const responseStream = await ai.models.generateContentStream({
            model: model,
            contents: contents,
            config: {
              temperature: 0,
              responseMimeType: "application/json",
              thinkingConfig: { 
                thinkingLevel: ThinkingLevel.MINIMAL 
              },
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    t: { type: Type.STRING, description: "Title" },
                    a: { type: Type.STRING, description: "Author" },
                    c: { 
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: "Content paragraphs"
                    },
                    sp: { type: Type.STRING, description: "See page" },
                    ic: { 
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: "Image captions" 
                    }
                  },
                  required: ["t", "c"]
                }
              },
            },
          });

          let fullText = "";
          for await (const chunk of responseStream) {
            if (chunk.text) {
              fullText += chunk.text;
            }
          }
          
          // Need to implement extractCompleteObjects here or import it
          // For now, assume fullText is valid JSON array as per schema
          const parsed = JSON.parse(fullText);
          finalArticles = parsed.map((art: any) => ({
            title: art.t,
            author: art.a,
            content: art.c,
            seePage: art.sp,
            imageCaption: art.ic
          }));
          
          success = true;
          break;
        } catch (error: any) {
          console.error(`Lỗi với model ${model}:`, error);
          continue;
        }
      }
      if (success) break;
    }

    if (!success) {
      return NextResponse.json({ error: 'Failed to extract articles' }, { status: 500 });
    }

    return NextResponse.json({ articles: finalArticles });
  } catch (error) {
    console.error("Error in API route:", error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
