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
    
    QUY TẮC ĐỌC VÀ SẮP XẾP (BẮT BUỘC):
    1. THỨ TỰ ƯU TIÊN THÀNH PHẦN: Tiêu đề -> Tác giả -> Chú thích ảnh -> Sapo -> Nội dung.
    2. XỬ LÝ CÁC THÀNH PHẦN VẮT CỘT (Tiêu đề, Chú thích ảnh, Sapo): Nếu các thành phần này có chiều rộng lớn (vắt qua từ 2 cột trở lên) và nằm phía trên hoặc xen giữa các cột nội dung, BẮT BUỘC phải trích xuất và đưa vào bài báo TRƯỚC khi đọc các cột nội dung.
    3. XỬ LÝ CÁC CỘT NỘI DUNG: Sau khi đã đọc các thành phần vắt cột, hãy đọc tất cả các cột nội dung còn lại theo thứ tự từ TRÁI sang PHẢI. Trong mỗi cột, đọc từ TRÊN xuống DƯỚI.
    4. XỬ LÝ CÁC KHỐI VĂN BẢN GÂY NHẦM LẪN: Nếu trong cột nội dung có các dòng chữ viết hoa (trông giống tiêu đề) nhưng có độ rộng nằm gọn trong cột, BẮT BUỘC phải coi đó là một phần của nội dung và đọc theo thứ tự xuất hiện trong cột đó, KHÔNG được tách ra làm tiêu đề chính.
    
    QUY TẮC CHUNG:
    - KHÔNG tóm tắt, KHÔNG sửa nội dung, KHÔNG bỏ sót bất kỳ đoạn văn nào thuộc về bài báo.
    - Loại bỏ Header/Footer (tên báo, ngày tháng, số trang).
    - Tìm các chỉ dẫn chuyển trang (ví dụ: "(Xem tiếp trang 5)") và đưa vào trường seePage.
    - ĐẶC BIỆT CHÚ Ý: Các bài báo thường có chữ cái in hoa rất lớn ở đầu đoạn (Dropcap). Bạn BẮT BUỘC phải tìm chữ cái này và ghép nó vào đúng vị trí của từ đầu tiên trong đoạn văn.
    
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
