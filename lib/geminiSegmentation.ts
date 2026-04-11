import { GoogleGenAI, Type } from "@google/genai";

export const cropImageToCanvas = async (imageSrc: string, x: number, y: number, width: number, height: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject('Could not get canvas context');
        return;
      }
      ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = imageSrc;
  });
};

export const segmentContentParagraphs = async (
  imageSrc: string,
  contentItems: any[],
  region: any,
  ai: GoogleGenAI
): Promise<any[]> => {
  // 1. Crop image
  const croppedImage = await cropImageToCanvas(imageSrc, region.x, region.y, region.width, region.height);
  
  // 2. Call Gemini
  const FALLBACK_MODELS = [
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash-image",
    "gemini-3.1-flash-image-preview"
  ];

  let response;
  let currentModelIndex = 0;
  let retries = 0;
  const maxRetriesPerModel = 2;
  let delay = 2000;

  while (currentModelIndex < FALLBACK_MODELS.length) {
    const currentModel = FALLBACK_MODELS[currentModelIndex];
    try {
      console.log(`Trying segmentation with model: ${currentModel} (Attempt ${retries + 1})`);
      const result = await ai.models.generateContent({
        model: currentModel,
        contents: [
          {
            inlineData: {
              mimeType: "image/png",
              data: croppedImage.split(',')[1]
            }
          },
          {
            text: "Analyze the provided image of a newspaper article content region. Identify the start coordinates (x, y) of each paragraph. Return the result as a JSON array of objects with 'x' and 'y' properties, relative to the cropped image."
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER }
              },
              required: ["x", "y"]
            }
          }
        }
      });
      response = result;
      break; // Success
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      const isRateLimit = error?.status === 429 || 
                          error?.status === "RESOURCE_EXHAUSTED" || 
                          errorMsg.includes("429") || 
                          errorMsg.includes("quota") ||
                          errorMsg.includes("RESOURCE_EXHAUSTED") ||
                          errorMsg.includes("Too Many Requests");
      
      const isNotFound = error?.status === 404 || 
                         errorMsg.includes("not found") || 
                         errorMsg.includes("is not supported");

      const isInvalidKey = error?.status === 400 || 
                           errorMsg.includes("400") || 
                           errorMsg.includes("API_KEY_INVALID") || 
                           errorMsg.includes("key not valid");

      const isUnavailable = error?.status === 503 || 
                            errorMsg.includes("503") || 
                            errorMsg.includes("UNAVAILABLE") || 
                            errorMsg.includes("high demand");

      if (isInvalidKey) {
        console.error(`[${currentModel}] API Key invalid in segmentation. Skipping model...`);
        currentModelIndex++;
        retries = 0;
        delay = 2000;
        continue;
      }

      if (isUnavailable) {
        if (retries < maxRetriesPerModel) {
          const retryDelay = delay + Math.random() * 1000;
          console.warn(`[${currentModel}] Model unavailable/high demand in segmentation. Retrying in ${Math.round(retryDelay)}ms... (Attempt ${retries + 1} of ${maxRetriesPerModel})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          retries++;
          delay *= 2;
          continue;
        } else {
          console.warn(`[${currentModel}] Max retries reached for unavailable model. Switching to next fallback model...`);
          currentModelIndex++;
          retries = 0;
          delay = 2000;
          continue;
        }
      }

      if (isRateLimit) {
        if (retries < maxRetriesPerModel) {
          const retryDelay = delay + Math.random() * 1000;
          console.warn(`[${currentModel}] API rate limit hit in segmentation. Retrying in ${Math.round(retryDelay)}ms... (Attempt ${retries + 1} of ${maxRetriesPerModel})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          retries++;
          delay *= 2;
          continue;
        } else {
          console.warn(`[${currentModel}] Quota exceeded. Switching to next fallback model...`);
          currentModelIndex++;
          retries = 0;
          delay = 2000;
          continue;
        }
      } else if (isNotFound) {
        console.warn(`[${currentModel}] Model not found. Switching to next fallback model...`);
        currentModelIndex++;
        retries = 0;
        delay = 2000;
        continue;
      } else {
        console.error(`Error segmenting content with Gemini [${currentModel}]:`, error);
        throw error;
      }
    }
  }

  if (!response || !response.text) throw new Error("All fallback models failed or no response from Gemini");

  const paragraphs = JSON.parse(response.text || '[]');
  
  // 3. Match paragraphs with contentItems (fuzzy matching)
  // Map paragraphs to the nearest content item
  const segmentedContent = contentItems.map(item => {
    const closestParagraph = paragraphs.reduce((prev: any, curr: any) => {
      const dist = Math.sqrt(Math.pow(curr.x - (item.x - region.x), 2) + Math.pow(curr.y - (item.y - region.y), 2));
      const prevDist = Math.sqrt(Math.pow(prev.x - (item.x - region.x), 2) + Math.pow(prev.y - (item.y - region.y), 2));
      return dist < prevDist ? curr : prev;
    }, paragraphs[0]);

    // If close enough, mark as paragraph start
    const isParagraphStart = closestParagraph && Math.sqrt(Math.pow(closestParagraph.x - (item.x - region.x), 2) + Math.pow(closestParagraph.y - (item.y - region.y), 2)) < 20;

    return {
      ...item,
      isParagraphStart
    };
  });
  
  return segmentedContent;
};
