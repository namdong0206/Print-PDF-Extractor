import { GoogleGenAI, Type } from "@google/genai";

// Interface cho TextBlock (tối ưu hóa tên trường để giảm dung lượng JSON)
export interface TextBlock {
  id: number;
  t: string; // text (full)
  fs: number; // font_size
  b: boolean; // is_bold
  x: number;
  y: number;
}

export interface Article {
  id: string;
  articleRegionId: string;
  title: string;
  author: string;
  lead: string;
  content: string[];
  imageCaption: string;
  seePage: string;
  pageNumbers: number[];
  fileName?: string;
}

export function mergeArticles(articles: Article[]): Article[] {
  const merged: Article[] = [];
  
  for (const article of articles) {
    const existingIndex = merged.findIndex(a => 
      a.title.toLowerCase().trim() === article.title.toLowerCase().trim()
    );
    
    if (existingIndex !== -1) {
      // Merge
      const existing = merged[existingIndex];
      existing.content = [...existing.content, ...article.content];
      existing.pageNumbers = [...new Set([...existing.pageNumbers, ...article.pageNumbers])];
      // Keep the first lead/author/caption if not present in existing
      if (!existing.lead && article.lead) existing.lead = article.lead;
      if (!existing.author && article.author) existing.author = article.author;
      if (!existing.imageCaption && article.imageCaption) existing.imageCaption = article.imageCaption;
    } else {
      merged.push(article);
    }
  }
  return merged;
}

/**
 * Bước 1: Trích xuất Text & Metadata bằng pdf.js
 */
export async function extractTextBlocksWithMetadata(page: any): Promise<TextBlock[]> {
  console.log("--- [DEBUG] extractTextBlocksWithMetadata called ---");
  console.time("ExtractionTime");
  try {
    const textContent = await page.getTextContent();
    const items = textContent.items;
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;
    
    // 1. Trích xuất thô và chuẩn hóa tọa độ
    const rawBlocks: TextBlock[] = items.map((item: any, index: number) => {
      const fontSize = Math.round(Math.sqrt(item.transform[0] * item.transform[0] + item.transform[1] * item.transform[1]));
      return {
        id: index,
        t: item.str,
        fs: fontSize,
        x: item.transform[4],
        y: pageHeight - item.transform[5] - fontSize,
        b: item.fontName?.toLowerCase().includes('bold') || item.fontName?.toLowerCase().includes('heavy') || false,
      };
    });

    if (rawBlocks.length === 0) return [];

    // 2. Sắp xếp theo thứ tự đọc (từ trên xuống, từ trái sang)
    rawBlocks.sort((a, b) => {
      if (Math.abs(a.y - b.y) < 5) return a.x - b.x;
      return a.y - b.y;
    });

    // 3. Gom các items thành dòng (Line merging) - Cực kỳ quyết liệt
    const lineBlocks: TextBlock[] = [];
    let currentLine = { ...rawBlocks[0] };

    for (let i = 1; i < rawBlocks.length; i++) {
      const nextItem = rawBlocks[i];
      // Cho phép chênh lệch y lớn hơn để gom các dòng bị lệch nhẹ
      const sameLine = Math.abs(currentLine.y - nextItem.y) < 12;
      // Khoảng cách x rất rộng để gom các thành phần rời rạc trong cùng một dòng/vùng
      const closeX = nextItem.x - (currentLine.x + currentLine.t.length * (currentLine.fs * 0.3)) < 200;

      if (sameLine && closeX) {
        currentLine.t += " " + nextItem.t;
      } else {
        lineBlocks.push(currentLine);
        currentLine = { ...nextItem };
      }
    }
    lineBlocks.push(currentLine);

    // 4. Gom các dòng thành đoạn văn (Paragraph merging) - Mục tiêu giảm số lượng block xuống mức tối thiểu
    const paragraphBlocks: TextBlock[] = [];
    let currentPara = { ...lineBlocks[0] };

    for (let i = 1; i < lineBlocks.length; i++) {
      const nextLine = lineBlocks[i];
      
      // Cùng cột (x gần nhau)
      const sameColumn = Math.abs(currentPara.x - nextLine.x) < 60;
      // Khoảng cách dòng (y gần nhau)
      const closeVertical = Math.abs(nextLine.y - (currentPara.y + currentPara.fs)) < 45;
      // Cùng kiểu font hoặc đều là font nhỏ (body text)
      const bothSmall = currentPara.fs < 13 && nextLine.fs < 13;
      const sameStyle = (Math.abs(currentPara.fs - nextLine.fs) <= 3 && currentPara.b === nextLine.b) || bothSmall;
      
      // Tiêu đề (Headline) luôn đứng riêng
      const isHeadline = currentPara.fs > 15;

      if (sameColumn && closeVertical && sameStyle && !isHeadline) {
        currentPara.t += " " + nextLine.t;
      } else {
        paragraphBlocks.push(currentPara);
        currentPara = { ...nextLine };
      }
    }
    paragraphBlocks.push(currentPara);

    // Đánh lại ID cho các block đã tối ưu
    const finalBlocks = paragraphBlocks.map((b, i) => ({ ...b, id: i }));

    console.timeEnd("ExtractionTime");
    console.log(`Thống kê block: Gốc=${rawBlocks.length} -> Dòng=${lineBlocks.length} -> Đoạn=${finalBlocks.length}`);
    return finalBlocks;
  } catch (error) {
    console.timeEnd("ExtractionTime");
    console.error("Error extracting text blocks:", error);
    throw error;
  }
}

export interface ArticleStructure {
  title_id: number;
  author_ids: string; // Comma separated IDs
  sapo_ids: string; // Comma separated IDs
  body_ids: string; // Comma separated IDs
}

/**
 * Bước 2 & 3: Gọi API Gemini để xử lý bài báo (Multimodal: Ảnh + Text)
 */
export async function extractArticlesMultimodal(
  regionImages: string[],
  textBlocks: TextBlock[],
  pageNumber: number,
  fileName: string
): Promise<Article[]> {
  console.log("--- [DEBUG] extractArticlesMultimodal called ---");
  const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY! });
  
  // Tối ưu hóa dữ liệu gửi đi
  const optimizedForGemini = textBlocks.map(b => ({
    id: b.id,
    t: b.t,
    fs: b.fs,
    b: b.b,
    x: Math.round(b.x),
    y: Math.round(b.y)
  }));

  const jsonPayload = JSON.stringify(optimizedForGemini);
  console.log(`Kích thước gửi: ${(new Blob([jsonPayload]).size / 1024).toFixed(2)} KB (Blocks: ${textBlocks.length})`);

  const prompt = `
  Bạn là chuyên gia phân tích cấu trúc báo chí. 
  Đầu vào là các ảnh cắt của từng vùng bài báo (Article Region) và danh sách các đoạn văn (TextBlock) được trích xuất từ file PDF.
  Nhiệm vụ: Sắp xếp lại cho chuẩn các bài báo và trả về dữ liệu JSON theo từng bài.
  
  YÊU CẦU QUAN TRỌNG:
  1. Trả về mảng JSON chứa các bài báo.
  2. Mỗi bài báo phải có ĐẦY ĐỦ các phần tử: Tiêu đề, Tác giả, Sapo, Nội dung, Chú thích ảnh, Xem trang/Tiếp theo trang.
  3. BẢO ĐẢM NỘI DUNG GIỮ NGUYÊN VĂN từ các TextBlock, KHÔNG thêm bớt, KHÔNG thay đổi từ ngữ.
  4. Với những bài bị phân chia nhầm (ví dụ 1 bài bị tách thành 2 vùng), hãy tự động nhận diện và ghép lại cho chuẩn thành 1 bài hoàn chỉnh.
  5. Nội dung (content) phải là một mảng các chuỗi, mỗi chuỗi tương ứng với một đoạn văn.

  CẤU TRÚC JSON TRẢ VỀ CHO MỖI BÀI BÁO:
  - title: Tiêu đề bài báo (string)
  - author: Tác giả (string)
  - lead: Sapo / Lead (string)
  - content: Nội dung bài báo (array of strings)
  - imageCaption: Chú thích ảnh (string)
  - seePage: Xem trang / Tiếp theo trang (string)

  DANH SÁCH TEXT BLOCKS:
  ${jsonPayload}
  `;

  const imageParts = regionImages.map(img => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: img.includes(",") ? img.split(",")[1] : img,
    },
  }));

  const textPart = {
    text: prompt,
  };

  console.time("GeminiAPITime");
  
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
  const maxRetriesPerModel = 2; // Retry a couple of times before switching
  let delay = 2000; // Start with 2 seconds

  while (currentModelIndex < FALLBACK_MODELS.length) {
    const currentModel = FALLBACK_MODELS[currentModelIndex];
    try {
      response = await ai.models.generateContent({
        model: currentModel,
        contents: { parts: [...imageParts, textPart] },
        config: {
          temperature: 0.1,
          responseMimeType: "application/json",
          maxOutputTokens: 16384,
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                author: { type: Type.STRING },
                lead: { type: Type.STRING },
                content: { 
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                imageCaption: { type: Type.STRING },
                seePage: { type: Type.STRING }
              },
              required: ["title", "content"]
            }
          },
        },
      });
      break; // Success, exit retry loop
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
          console.warn(`[${currentModel}] Rate limit hit. Retrying in ${delay}ms... (Attempt ${retries + 1} of ${maxRetriesPerModel})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retries++;
          delay *= 2; // Exponential backoff
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
        console.timeEnd("GeminiAPITime");
        console.error(`Error processing articles with Gemini [${currentModel}]:`, error);
        throw error;
      }
    }
  }

  console.timeEnd("GeminiAPITime");

  if (!response || !response.text) throw new Error("All fallback models failed or no response from Gemini");

  const responseText = response.text.trim();
    console.log(`Kích thước nhận: ${(new Blob([responseText]).size / 1024).toFixed(2)} KB`);

    try {
      let cleanedJson = responseText;
      if (cleanedJson.startsWith("```json")) {
        cleanedJson = cleanedJson.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (cleanedJson.startsWith("```")) {
        cleanedJson = cleanedJson.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      
      const rawResult = JSON.parse(cleanedJson);
      
      return rawResult.map((art: any) => ({
        title: art.title || "Không có tiêu đề",
        author: art.author || "",
        lead: art.lead || "",
        content: (Array.isArray(art.content) ? art.content : [])
          .map((p: string) => p.replace(/\((Tiếp theo trang|XEM TRANG).*?\)/gi, '').trim())
          .filter((p: string) => p.length > 0 && (!art.imageCaption || !p.startsWith(art.imageCaption))),
        imageCaption: art.imageCaption || "",
        seePage: "", // Ignore seePage
        pageNumbers: [pageNumber],
        fileName: fileName
      }));
    } catch (parseError) {
      console.error("JSON Parse Error. Raw response snippet:", responseText.substring(0, 300) + "..." + responseText.substring(responseText.length - 300));
      throw new Error(`Failed to parse Gemini response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
}
