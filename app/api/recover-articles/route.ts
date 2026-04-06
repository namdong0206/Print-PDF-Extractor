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
    const modelsToTry = ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"];

    let finalRecovery: any = null;
    let success = false;
    let lastError: any = null;

    for (const apiKey of apiKeys) {
      for (const model of modelsToTry) {
        const ai = new GoogleGenAI({ apiKey });
        let retries = 0;
        const maxRetries = 2;
        while (retries <= maxRetries) {
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
            break;
          } catch (error: any) {
            lastError = error;
            const errorStr = error.toString();
            const isQuotaError = errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED');
            const isUnavailableError = errorStr.includes('503') || errorStr.includes('UNAVAILABLE');
            const isInternalError = errorStr.includes('500') || errorStr.includes('INTERNAL');

            if (isQuotaError) {
              // On quota error, don't retry the same model/key.
              // Move to the next model or next key immediately.
              console.log(`Quota exceeded for ${model} in recovery. Moving to next model/key...`);
              break; // Break the while loop to try next model/key
            }

            if ((isUnavailableError || isInternalError) && retries < maxRetries) {
              retries++;
              let waitTime = 5000; // Fixed wait for 503/500
              
              try {
                const match = errorStr.match(/\{[\s\S]*\}/);
                if (match) {
                  const parsed = JSON.parse(match[0]);
                  let actualError = parsed.error;
                  if (parsed.error?.message) {
                    try {
                      const inner = JSON.parse(parsed.error.message);
                      if (inner.error) actualError = inner.error;
                    } catch (e) {
                      // Not a JSON message
                    }
                  }
                  const delayStr = actualError?.details?.find((d: any) => d.retryDelay)?.retryDelay;
                  
                  if (delayStr) {
                    if (delayStr.endsWith('ms')) {
                      const ms = parseFloat(delayStr.replace('ms', ''));
                      if (!isNaN(ms)) waitTime = Math.max(waitTime, ms + 100);
                    } else if (delayStr.endsWith('s')) {
                      const seconds = parseFloat(delayStr.replace('s', ''));
                      if (!isNaN(seconds)) waitTime = Math.max(waitTime, (seconds + 1) * 1000);
                    }
                  }
                }
              } catch (e) {}

              const errorType = isUnavailableError ? 'Model unavailable' : 'Internal error';
              console.log(`${errorType} for ${model} in recovery. Retrying in ${waitTime}ms... (Attempt ${retries}/${maxRetries})`);
              await sleep(waitTime);
              continue;
            }
            break;
          }
        }
        if (success) break;
      }
      if (success) break;
    }

    if (!success) return NextResponse.json({ error: lastError?.toString() }, { status: 500 });
    return NextResponse.json({ recovery: finalRecovery });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
