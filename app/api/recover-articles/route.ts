import { NextResponse } from 'next/server';
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

function getApiKeys(): string[] {
  const defaultApiKeyStr = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";
  const customApiKeysStr = process.env.CUSTOM_GEMINI_API_KEYS || process.env.NEXT_PUBLIC_CUSTOM_GEMINI_API_KEYS || "";
  
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
  if (apiKeys.length === 0) throw new Error("No valid API keys found.");
  return apiKeys;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function POST(req: Request) {
  try {
    const { missingBlocks, existingArticleTitles } = await req.json();
    const apiKeys = getApiKeys();

    const prompt = `
    HÀNH ĐỘNG KHẨN CẤP: Trong lần xử lý trước, bạn đã bỏ sót một số khối văn bản quan trọng. 
    
    DỮ LIỆU BỊ SÓT (Blocks):
    ${JSON.stringify(missingBlocks)}
    
    DANH SÁCH BÀI BÁO ĐÃ TÌM THẤY:
    ${JSON.stringify(existingArticleTitles)}
    
    NHIỆM VỤ:
    Hãy phân tích các khối bị sót này và trả về kết quả JSON là một mảng các đối tượng. 
    LƯU Ý: Bạn KHÔNG CẦN trích xuất lại nội dung văn bản. Chỉ cần xác định khối đó thuộc về bài báo nào hoặc là bài báo mới.
    
    Cấu trúc trả về:
    1. Nếu khối thuộc về một bài báo đã có: Trả về {"id": [ID], "action": "APPEND", "toTitle": "[Tiêu đề bài báo]"}.
    2. Nếu khối là một bài báo mới: Trả về {"id": [ID], "action": "NEW_ARTICLE", "data": {"title": "[Tiêu đề mới gợi ý]", "assignedIds": [[ID]]}}.
    3. Nếu khối thực sự là rác: Trả về {"id": [ID], "action": "JUNK"}.
    `;

    const contents = [{ parts: [{ text: prompt }] }];
    const modelsToTry = [
      "gemini-3-flash-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview"
    ];

    let finalRecovery: any = null;
    let success = false;
    let lastError: any = null;

    for (const apiKey of apiKeys) {
      const ai = new GoogleGenAI({ apiKey });
      let keyInvalid = false;

      for (const model of modelsToTry) {
        let retries = 0;
        const maxRetries = 2;

        while (retries <= maxRetries) {
          try {
            console.log(`Trying article recovery with model: ${model} (Attempt ${retries + 1})`);
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
                      id: { type: Type.INTEGER },
                      action: { type: Type.STRING, enum: ["APPEND", "NEW_ARTICLE", "JUNK"] },
                      toTitle: { type: Type.STRING },
                      data: {
                        type: Type.OBJECT,
                        properties: {
                          title: { type: Type.STRING },
                          assignedIds: { type: Type.ARRAY, items: { type: Type.INTEGER } }
                        }
                      }
                    },
                    required: ["id", "action"]
                  }
                }
              }
            });

            finalRecovery = JSON.parse(response.text || "[]");
            success = true;
            break; // Success!
          } catch (error: any) {
            const errorStr = error.toString();
            const isInvalidKey = errorStr.includes('400') || errorStr.includes('API_KEY_INVALID') || errorStr.includes('key not valid');
            const isQuotaError = errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED');
            const isUnavailable = errorStr.includes('503') || errorStr.includes('UNAVAILABLE') || errorStr.includes('high demand');
            
            if (isInvalidKey) {
              console.error(`API Key invalid in recovery: ${apiKey.substring(0, 8)}...`);
              keyInvalid = true;
              lastError = error;
              break; // Skip all models for this key
            }
            
            if (isQuotaError) {
              console.warn(`Quota exceeded for ${model} in recovery with key ${apiKey.substring(0, 8)}...`);
              lastError = error;
              break; // Try next model
            }
            
            if (isUnavailable && retries < maxRetries) {
              retries++;
              const waitTime = 2000 * retries;
              console.warn(`Model ${model} unavailable/high demand in recovery. Retrying in ${waitTime}ms... (${retries}/${maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue; // Retry same model
            }

            console.error(`Lỗi với model ${model} trong recovery:`, error);
            lastError = error;
            break; // Try next model
          }
        }
        if (success || keyInvalid) break;
      }
      if (success) break;
    }

    if (!success) return NextResponse.json({ error: lastError?.toString() }, { status: 500 });
    return NextResponse.json({ recovery: finalRecovery });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
