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
    Bạn là chuyên gia biên tập báo chí. Nhiệm vụ: Trích xuất và sắp xếp lại nội dung thành các bài báo hoàn chỉnh từ JSON zones.
    
    QUY TẮC QUAN TRỌNG:
    1. KHÔNG tóm tắt, KHÔNG sửa nội dung, KHÔNG bỏ sót bất kỳ đoạn văn nào thuộc về bài báo.
    2. Gộp Sapo/Tít phụ vào Content.
    3. Loại bỏ Header/Footer (thường là tên báo, ngày tháng, số trang ở rìa trang).
    4. Giữ nguyên tiêu đề bài báo.
    5. Các thành phần trong một khối tin bài sẽ luôn được gom trong phạm vi một hình tứ giác (hình vuông hoặc hình chữ nhật). Hãy sử dụng đặc điểm không gian này để nhóm các khối văn bản chính xác.
    6. Nếu một đoạn văn trông giống Caption nhưng chứa nội dung dẫn dắt câu chuyện, hãy giữ lại trong Content.
    7. Đảm bảo trích xuất ĐẦY ĐỦ 100% văn bản của bài báo.
    8. Tìm các chỉ dẫn chuyển trang (ví dụ: "(Xem tiếp trang 5)", "(Tiếp theo trang 1)") và đưa vào trường seePage.
    9. ĐẶC BIỆT CHÚ Ý: Các bài báo thường có chữ cái in hoa rất lớn ở đầu đoạn (Dropcap). Chữ cái này có thể bị tách rời về mặt đồ họa hoặc nằm trong một block riêng biệt. Bạn BẮT BUỘC phải tìm chữ cái này và ghép nó vào đúng vị trí của từ đầu tiên trong đoạn văn. Tuyệt đối không được bỏ sót ký tự Dropcap.
    
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
                    title: { type: Type.STRING },
                    author: { type: Type.STRING },
                    content: { 
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    },
                    seePage: { type: Type.STRING },
                    imageCaption: { type: Type.STRING }
                  },
                  required: ["title", "content"]
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
          finalArticles = JSON.parse(fullText);
          
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
