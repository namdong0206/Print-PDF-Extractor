import { NextResponse } from 'next/server';
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

function getApiKeys(): string[] {
  const keys = [
    process.env.GEMINI_API_KEY,
    process.env.NEXT_PUBLIC_GEMINI_API_KEY,
    process.env.CUSTOM_GEMINI_API_KEYS,
    process.env.NEXT_PUBLIC_CUSTOM_GEMINI_API_KEYS
  ];
  
  const apiKeys: string[] = [];
  keys.forEach(keyStr => {
    if (keyStr) {
      keyStr.split(',').forEach(k => {
        const trimmed = k.trim();
        if (trimmed && trimmed.length > 10 && !apiKeys.includes(trimmed)) {
          apiKeys.push(trimmed);
        }
      });
    }
  });

  if (apiKeys.length === 0) {
    throw new Error("No valid API keys found. Please set GEMINI_API_KEY or NEXT_PUBLIC_GEMINI_API_KEY.");
  }
  return apiKeys;
}

export async function POST(req: Request) {
  try {
    const { base64Image, pageNumber, fileName } = await req.json();
    const apiKeys = getApiKeys();

    const prompt = `
    Bạn là một hệ thống AI chuyên phân tích layout báo in và trích xuất nội dung bài báo từ file PDF.
    Hãy phân tích bố cục trang báo này một cách cực kỳ chính xác. 
    
    Nhiệm vụ quan trọng nhất: Xác định tọa độ [ymin, xmin, ymax, xmax] (chuẩn hóa 0-1000) cho từng thành phần.
    
    Yêu cầu đặc biệt về độ chính xác:
    1. Các khung (bounding boxes) của các cột báo (BODY_COLUMN) và đoạn văn (PARAGRAPH) phải sát khít với nội dung text, TUYỆT ĐỐI KHÔNG được đè lên nhau hoặc lấn sang cột bên cạnh.
    2. Phân đoạn (PARAGRAPH) cụ thể trong từng cột. 
    3. Xác định thứ tự đọc (reading_order) logic từ trên xuống dưới, từ trái sang phải.
    4. Nếu là đoạn văn trong cột, hãy ghi rõ parent_column_index (index của BODY_COLUMN chứa nó).
    5. Đảm bảo khoảng cách giữa các khung của hai cột cạnh nhau (khe cột) phải rõ ràng để tránh nhầm lẫn text.
    6. Nhận diện các thành phần: TITLE, AUTHOR, SAPO, BODY_COLUMN, PARAGRAPH, IMAGE, CAPTION, HEADER, FOOTER, ADVERTISEMENT, PAGE_NUMBER, SEE_PAGE, FROM_PAGE.
    7. Nhóm các vùng văn bản thuộc cùng một bài báo bằng article_id.
    
    LOẠI BỎ CÁC THÀNH PHẦN KHÔNG PHẢI NỘI DUNG BÀI BÁO:
    - HEADER, FOOTER, PAGE_NUMBER, ADVERTISEMENT.
    
    PHỤC DỰNG THỨ TỰ ĐỌC:
    - Đọc theo cột, từ trên xuống dưới, sau đó chuyển sang cột kế tiếp.
    
    Kết quả trả về là một danh sách các đối tượng JSON, mỗi đối tượng đại diện cho một thành phần layout.
    `;

    const base64Data = base64Image.split(',')[1] || base64Image;
    const contents = [
      {
        role: 'user',
        parts: [
          { inlineData: { data: base64Data, mimeType: "image/png" } },
          { text: prompt }
        ]
      }
    ];

    const modelsToTry = [
      "gemini-3-flash-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview"
    ];

    let layoutElements: any[] = [];
    let success = false;
    let lastError = null;

    for (const apiKey of apiKeys) {
      const ai = new GoogleGenAI({ apiKey });
      let keyInvalid = false;

      for (const model of modelsToTry) {
        let retries = 0;
        const maxRetries = 2;

        while (retries <= maxRetries) {
          try {
            console.log(`Trying layout analysis with model: ${model} (Attempt ${retries + 1})`);
            const result = await ai.models.generateContent({
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
                      label: { 
                        type: Type.STRING, 
                        enum: ["TITLE", "AUTHOR", "SAPO", "BODY_COLUMN", "PARAGRAPH", "IMAGE", "CAPTION", "HEADER", "FOOTER", "ADVERTISEMENT", "PAGE_NUMBER", "SEE_PAGE", "FROM_PAGE"],
                        description: "Loại thành phần layout" 
                      },
                      box_2d: { 
                        type: Type.ARRAY, 
                        items: { type: Type.NUMBER },
                        description: "[ymin, xmin, ymax, xmax] chuẩn hóa 0-1000" 
                      },
                      text: { type: Type.STRING, description: "Nội dung văn bản bên trong (nếu có)" },
                      reading_order: { type: Type.NUMBER, description: "Thứ tự đọc logic" },
                      parent_column_index: { type: Type.NUMBER, description: "Index của BODY_COLUMN chứa đoạn văn này (nếu là PARAGRAPH)" },
                      article_id: { type: Type.STRING, description: "ID của bài báo mà thành phần này thuộc về (để nhóm các thành phần)" }
                    },
                    required: ["label", "box_2d", "reading_order"]
                  }
                }
              }
            });

            const text = result.text;
            if (!text) {
              console.warn(`Model ${model} returned empty text`);
              break; // Try next model
            }
            
            layoutElements = JSON.parse(text);
            success = true;
            break; // Success!
          } catch (error: any) {
            const errorStr = error.toString();
            const isInvalidKey = errorStr.includes('400') || errorStr.includes('API_KEY_INVALID') || errorStr.includes('key not valid');
            const isQuotaError = errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED');
            const isUnavailable = errorStr.includes('503') || errorStr.includes('UNAVAILABLE') || errorStr.includes('high demand');
            
            if (isInvalidKey) {
              console.error(`API Key invalid: ${apiKey.substring(0, 8)}...`);
              keyInvalid = true;
              lastError = error;
              break; // Skip all models for this key
            }
            
            if (isQuotaError) {
              console.warn(`Quota exceeded for ${model} with key ${apiKey.substring(0, 8)}...`);
              lastError = error;
              break; // Try next model
            }
            
            if (isUnavailable && retries < maxRetries) {
              retries++;
              const waitTime = 2000 * retries;
              console.warn(`Model ${model} unavailable/high demand. Retrying in ${waitTime}ms... (${retries}/${maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue; // Retry same model
            }

            console.error(`Lỗi với model ${model}:`, error);
            lastError = error;
            break; // Try next model
          }
        }
        if (success || keyInvalid) break;
      }
      if (success) break;
    }

    if (!success) {
      return NextResponse.json({ 
        error: 'Failed to analyze layout', 
        details: lastError?.message || 'Unknown error' 
      }, { status: 500 });
    }

    return NextResponse.json({ elements: layoutElements });
  } catch (error) {
    console.error("Error in layout analysis API:", error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
