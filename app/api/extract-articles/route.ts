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
  
  const filterKey = (k: string) => {
    const trimmed = k.trim();
    return trimmed.length > 0 && !trimmed.includes("TODO_KEYHERE");
  };

  if (customApiKeysStr) {
    const customKeys = customApiKeysStr.split(',').filter(filterKey);
    apiKeys = [...apiKeys, ...customKeys];
  }
  
  if (defaultApiKeyStr) {
    const defaultKeys = defaultApiKeyStr.split(',').filter(filterKey);
    const uniqueDefaultKeys = defaultKeys.filter(k => !apiKeys.includes(k));
    apiKeys = [...apiKeys, ...uniqueDefaultKeys];
  }

  if (apiKeys.length === 0) {
    // If no valid keys, at least try the default one if it exists even if it looks like a placeholder
    const fallbackKey = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (fallbackKey && fallbackKey.trim().length > 0) {
      return [fallbackKey.trim()];
    }
    throw new Error("No valid API keys found.");
  }
  return apiKeys;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function POST(req: Request) {
  try {
    const { optimizedZones, pageNumber, fileName, base64Image } = await req.json();
    const apiKeys = getApiKeys();

    const jsonPayload = JSON.stringify(optimizedZones);
    
    const prompt = `
    Hãy phân tích bố cục trang báo này một cách cực kỳ chính xác.
    Nhiệm vụ quan trọng nhất: Xác định tọa độ [ymin, xmin, ymax, xmax] (chuẩn hóa 0-1000) cho từng thành phần.
    
    YÊU CẦU ĐẶC BIỆT VỀ ĐỘ CHÍNH XÁC:
    1. Các khung (bounding boxes) của các cột báo (BODY_COLUMN) và đoạn văn (PARAGRAPH) phải sát khít với nội dung text, TUYỆT ĐỐI KHÔNG được đè lên nhau hoặc lấn sang cột bên cạnh.
    2. Phân đoạn (PARAGRAPH) cụ thể trong từng cột.
    3. Xác định thứ tự đọc (reading_order) logic từ trên xuống dưới, từ trái sang phải.
    4. Nếu là đoạn văn trong cột, hãy ghi rõ parent_column_index.
    5. Đảm bảo khoảng cách giữa các khung của hai cột cạnh nhau (khe cột) phải rõ ràng để tránh nhầm lẫn text.
    
    YÊU CẦU VỀ NGỮ NGHĨA VÀ PHÂN LOẠI:
    - Gemini phải đọc kỹ nội dung để sắp xếp và phân loại các bài báo theo ngữ nghĩa một cách chuẩn xác nhất.
    - KHI SẮP XẾP VÀ PHÂN LOẠI, HÃY GHI ĐÈ (OVERWRITE) TOÀN BỘ CÁC PHÂN LOẠI TRƯỚC ĐÓ TỪ YOLO (DỮ LIỆU ZONES). Tin tưởng vào khả năng phân tích ngữ nghĩa của bạn hơn là các nhãn có sẵn.
    
    Sau đó sử dụng các tọa độ để sắp xếp văn bản theo các trường để trả về dữ liệu JSON hoàn chỉnh cho hệ thống.
    
    QUY TẮC TRÍCH XUẤT:
    - Gộp Sapo/Tít phụ vào Content.
    - Loại bỏ Header/Footer/Quảng cáo/Số trang.
    - Giữ nguyên tiêu đề gốc.
    - Trích xuất ĐẦY ĐỦ 100% văn bản, không tóm tắt.
    - Tìm chỉ dẫn chuyển trang (ví dụ: "(Xem tiếp trang 5)") đưa vào trường 'sp'.
    - Tìm Dropcap và ghép vào từ đầu tiên.
    
    DỮ LIỆU TEXT (JSON ZONES):
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
      "gemini-flash-latest",
      "gemini-3.1-pro-preview"
    ];

    let finalArticles: any[] = [];
    let success = false;
    let lastError = null;

    for (const apiKey of apiKeys) {
      for (const model of modelsToTry) {
        const ai = new GoogleGenAI({ apiKey });
        let retryCount = 0;
        const maxRetries = 2;

        while (retryCount <= maxRetries) {
          try {
            const response = await ai.models.generateContent({
              model: model,
              contents: contents,
              config: {
                temperature: 0,
                responseMimeType: "application/json",
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
                      ic: { type: Type.STRING, description: "Image caption" },
                      layout: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            type: { type: Type.STRING, enum: ["BODY_COLUMN", "PARAGRAPH", "HEADLINE", "SAPO", "AUTHOR", "CAPTION"] },
                            box_2d: { 
                              type: Type.ARRAY, 
                              items: { type: Type.NUMBER },
                              description: "[ymin, xmin, ymax, xmax] normalized 0-1000"
                            },
                            reading_order: { type: Type.NUMBER },
                            parent_column_index: { type: Type.NUMBER }
                          }
                        }
                      }
                    },
                    required: ["t", "c"]
                  }
                },
              }
            });

            const fullText = response.text;
            if (!fullText) throw new Error("Empty response from Gemini");
            
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
            lastError = error;
            // Check for rate limit or service unavailable
            const errorStr = JSON.stringify(error).toLowerCase();
            const isRetryable = errorStr.includes("429") || errorStr.includes("503") || errorStr.includes("quota") || errorStr.includes("unavailable");
            
            if (isRetryable) {
              retryCount++;
              if (retryCount <= maxRetries) {
                const waitTime = Math.pow(2, retryCount) * 1000;
                console.warn(`Model ${model} bị lỗi retryable, đang thử lại lần ${retryCount} sau ${waitTime}ms...`);
                await sleep(waitTime);
                continue;
              }
            }
            
            console.error(`Lỗi với model ${model}:`, error);
            break; // Thử model tiếp theo
          }
        }
        if (success) break;
      }
      if (success) break;
    }

    if (!success) {
      const errorMsg = lastError ? (lastError.message || JSON.stringify(lastError)) : 'Unknown error';
      return NextResponse.json({ error: 'Failed to extract articles', details: errorMsg }, { status: 500 });
    }

    return NextResponse.json({ articles: finalArticles });
  } catch (error: any) {
    console.error("Error in API route:", error);
    return NextResponse.json({ error: 'Internal Server Error', details: error.message }, { status: 500 });
  }
}
