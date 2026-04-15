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
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-8b"
  ];

  let response;
  let currentModelIndex = 0;
  let retries = 0;
  const maxRetriesPerModel = 2;
  let delay = 2000;

  while (currentModelIndex < FALLBACK_MODELS.length) {
    const currentModel = FALLBACK_MODELS[currentModelIndex];
    try {
      response = await ai.models.generateContent({
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
      break; // Success
    } catch (error: any) {
      const isRateLimit = error?.status === 429 || 
                          error?.status === "RESOURCE_EXHAUSTED" || 
                          error?.message?.includes("429") || 
                          error?.message?.includes("quota") ||
                          error?.message?.includes("RESOURCE_EXHAUSTED");
      
      const isNotFound = error?.status === 404 || 
                         error?.message?.includes("not found") || 
                         error?.message?.includes("is not supported");

      if (isRateLimit) {
        if (retries < maxRetriesPerModel) {
          console.warn(`[${currentModel}] API rate limit hit in segmentation. Retrying in ${delay}ms... (Attempt ${retries + 1} of ${maxRetriesPerModel})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retries++;
          delay *= 2;
        } else {
          console.warn(`[${currentModel}] Quota exceeded. Switching to next fallback model...`);
          currentModelIndex++;
          retries = 0;
          delay = 2000;
        }
      } else if (isNotFound) {
        console.warn(`[${currentModel}] Model not found. Switching to next fallback model...`);
        currentModelIndex++;
        retries = 0;
        delay = 2000;
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
