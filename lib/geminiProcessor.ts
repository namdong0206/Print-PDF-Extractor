import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { HLAZone } from "./hlaService";

// Interface cho TextBlock (tối ưu hóa tên trường để giảm dung lượng JSON)
export interface TextBlock {
  id: number;
  t: string; // text (full)
  fs: number; // font_size
  b: boolean; // is_bold
  x: number;
  y: number;
  w?: number; // width
  l?: string; // label (from HLA)
  ind?: boolean; // is_indented
}

export interface Article {
  id: string;
  articleRegionId: string;
  title: string;
  author: string;
  lead?: string;
  content: string[];
  imageCaption: string;
  seePage: string;
  pageNumbers: number[];
  fileName?: string;
  container_box?: { x: number; y: number; width: number; height: number };
  warning_blocks?: any[];
}

export class QuotaExhaustedError extends Error {
  public partialArticles: Article[];
  constructor(message: string, partialArticles: Article[]) {
    super(message);
    this.name = "QuotaExhaustedError";
    this.partialArticles = partialArticles;
  }
}

export const normalize = (s: string) => s.toLowerCase()
  .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "")
  .replace(/\s+/g, " ")
  .trim();

// Hàm tìm chiều dài chuỗi con chung dài nhất (Longest Common Substring)
const getLongestCommonSubstringLen = (s1: string, s2: string): number => {
  let maxLen = 0;
  const dp = Array(2).fill(0).map(() => Array(s2.length + 1).fill(0));
  
  for (let i = 1; i <= s1.length; i++) {
    const currRow = i % 2;
    const prevRow = (i - 1) % 2;
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[currRow][j] = dp[prevRow][j - 1] + 1;
        maxLen = Math.max(maxLen, dp[currRow][j]);
      } else {
        dp[currRow][j] = 0;
      }
    }
  }
  return maxLen;
};

// Hàm tính toán độ tương đồng của tiêu đề (so sánh trên toàn bộ chuỗi)
export const getTitleSimilarity = (t1: string, t2: string) => {
  const s1 = normalize(t1);
  const s2 = normalize(t2);
  if (s1 === s2) return 1;
  
  const minLen = Math.min(s1.length, s2.length);
  if (minLen < 10) return s1 === s2 ? 1 : 0; // Tiêu đề quá ngắn thì yêu cầu khớp chính xác

  // Tìm chuỗi con chung dài nhất giữa 2 tiêu đề
  const lcsLen = getLongestCommonSubstringLen(s1, s2);
  
  return lcsLen / minLen;
};

// Hàm kiểm tra độ tương đồng phần đầu (ít nhất 80%)
export const isSimilarTitle = (t1: string, t2: string) => {
  return getTitleSimilarity(t1, t2) >= 0.8;
};

export function mergeArticles(articles: Article[]): Article[] {
  const merged: Article[] = [];
  
  const cleanContent = (content: string[]) => {
    const cues = [
      /^\(xem trang.*\)$/i,
      /^\(xem tiếp trang.*\)$/i,
      /^\(tiếp theo trang.*\)$/i,
      /^\(tiếp từ trang.*\)$/i,
      /\(xem trang \d+\)/i,
      /\(tiếp theo trang \d+\)/i,
      /\(xem tiếp trang \d+\)/i,
      /xem trang \d+/i,
      /tiếp theo trang \d+/i,
      /xem tiếp trang \d+/i
    ];
    
    // Lọc và làm sạch các đoạn văn
    const cleanedParagraphs = content.filter(para => {
      const trimmed = para.trim();
      return !cues.some(regex => regex.test(trimmed));
    }).map(para => {
      // Also remove cues if they are at the end of a paragraph
      let cleaned = para;
      cues.forEach(regex => {
        cleaned = cleaned.replace(regex, "").trim();
      });
      return cleaned;
    }).filter(p => p.length > 0);

    // Nối đoạn nếu:
    // 1. Đoạn trước kết thúc bằng dấu phẩy
    // 2. Hoặc đoạn trước KHÔNG kết thúc bằng dấu chấm/chấm hỏi/chấm than VÀ đoạn tiếp theo bắt đầu bằng chữ thường
    const mergedParagraphs: string[] = [];
    for (let i = 0; i < cleanedParagraphs.length; i++) {
      let current = cleanedParagraphs[i];
      
      while (i + 1 < cleanedParagraphs.length) {
        const currentTrimmed = current.trim();
        const nextTrimmed = cleanedParagraphs[i + 1].trim();
        
        const endsWithComma = currentTrimmed.endsWith(',');
        const doesNotEndWithSentencePunctuation = !currentTrimmed.match(/[.!?]$/);
        
        const firstCharNext = nextTrimmed.charAt(0);
        // Kiểm tra xem ký tự đầu tiên có phải là chữ thường không (bao gồm cả tiếng Việt)
        const isNextLowercase = firstCharNext === firstCharNext.toLowerCase() && firstCharNext !== firstCharNext.toUpperCase();

        if (endsWithComma || (doesNotEndWithSentencePunctuation && isNextLowercase)) {
          current = currentTrimmed + " " + nextTrimmed;
          i++;
        } else {
          break;
        }
      }
      mergedParagraphs.push(current);
    }

    return mergedParagraphs;
  };

  for (const article of articles) {
    let existingIndex = merged.findIndex(a => isSimilarTitle(a.title, article.title));
    
    if (existingIndex === -1) {
      // Try to match by seePage cues if title matching fails but similarity is at least 30%
      existingIndex = merged.findIndex(a => {
        const similarity = getTitleSimilarity(a.title, article.title);
        if (similarity < 0.3) return false;

        const cleanSeePage = (s: string) => s.replace(/[()]/g, "").trim();
        const aSeePage = cleanSeePage(a.seePage || "");
        const artSeePage = cleanSeePage(article.seePage || "");

        const regexStart = /xem (tiếp )?trang (\d+)/i;
        const regexCont = /tiếp (theo|từ) trang (\d+)/i;

        const aStart = regexStart.exec(aSeePage);
        const artCont = regexCont.exec(artSeePage);
        
        if (aStart && artCont) {
          const targetPage = parseInt(aStart[2]);
          const sourcePage = parseInt(artCont[2]);
          
          if (article.pageNumbers.includes(targetPage) && a.pageNumbers.includes(sourcePage)) {
            return true;
          }
        }
        
        const artStart = regexStart.exec(artSeePage);
        const aCont = regexCont.exec(aSeePage);
        
        if (artStart && aCont) {
          const targetPage = parseInt(artStart[2]);
          const sourcePage = parseInt(aCont[2]);
          
          if (a.pageNumbers.includes(targetPage) && article.pageNumbers.includes(sourcePage)) {
            return true;
          }
        }
        
        return false;
      });
    }
    
    if (existingIndex !== -1) {
      const existing = merged[existingIndex];
      
      // Ghép nội dung, tránh lặp lại đoạn văn nếu AI trích xuất trùng
      const newContent = article.content.filter(p => !existing.content.includes(p));
      
      // Xác định thứ tự ghép dựa trên semantic cues hoặc số trang
      const isArticleContinuation = /tiếp theo trang|tiếp từ trang|tiếp theo/i.test(article.seePage || "");
      const isArticleStart = /xem trang|xem tiếp trang|xem tiếp/i.test(article.seePage || "");
      
      const isExistingContinuation = /tiếp theo trang|tiếp từ trang|tiếp theo/i.test(existing.seePage || "");
      const isExistingStart = /xem trang|xem tiếp trang|xem tiếp/i.test(existing.seePage || "");

      let append = true;
      
      if (isArticleContinuation && isExistingStart) {
        // Article là phần tiếp theo, Existing là phần đầu -> Append
        append = true;
      } else if (isArticleStart && isExistingContinuation) {
        // Article là phần đầu, Existing là phần tiếp theo -> Prepend
        append = false;
      } else if (isArticleContinuation && !isExistingContinuation) {
        // Article là phần tiếp theo, Existing không rõ -> Append
        append = true;
      } else if (isArticleStart && !isExistingStart) {
        // Article là phần đầu, Existing không rõ -> Prepend
        append = false;
      } else {
        // Fallback to page number nếu không có cue rõ ràng hoặc cues mâu thuẫn
        append = article.pageNumbers[0] > existing.pageNumbers[existing.pageNumbers.length - 1];
      }

      if (append) {
        existing.content = cleanContent([...existing.content, ...newContent]);
        if (article.seePage) existing.seePage = article.seePage;
      } else {
        existing.content = cleanContent([...newContent, ...existing.content]);
        // Giữ nguyên seePage của existing nếu nó là phần cuối
      }
      
      existing.pageNumbers = [...new Set([...existing.pageNumbers, ...article.pageNumbers])].sort((a, b) => a - b);
      
      if (!existing.author && article.author) existing.author = article.author;
      if (!existing.imageCaption && article.imageCaption) existing.imageCaption = article.imageCaption;
    } else {
      const newArt = { ...article };
      newArt.content = cleanContent(newArt.content);
      merged.push(newArt);
    }
  }

  // Xử lý đoạn cuối cùng của mỗi bài báo
  merged.forEach(article => {
    if (article.content.length > 0) {
      const lastIndex = article.content.length - 1;
      let lastPara = article.content[lastIndex].trim();
      
      if (lastPara.endsWith('■')) {
        lastPara = lastPara.slice(0, -1).trim();
        if (!lastPara.match(/[.!?]$/)) {
          lastPara += '.';
        }
      } else if (!lastPara.match(/[.!?]$/)) {
        lastPara += '.';
      }
      
      article.content[lastIndex] = lastPara;
    }
  });

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
        w: item.width || (item.str.length * fontSize * 0.5), // Ước tính nếu thiếu width
        b: item.fontName?.toLowerCase().includes('bold') || item.fontName?.toLowerCase().includes('heavy') || false,
      };
    });

    if (rawBlocks.length === 0) return [];

    // 2. Sắp xếp theo thứ tự đọc (từ trên xuống, từ trái sang)
    rawBlocks.sort((a, b) => {
      if (Math.abs(a.y - b.y) < 5) return a.x - b.x;
      return a.y - b.y;
    });

    // 3. Gom các items thành dòng (Line merging)
    // Cải tiến: Phát hiện "Horizontal Merging" để chẻ các block thuộc 2 cột khác nhau (Vertical Split)
    const lineBlocks: TextBlock[] = [];
    let currentLine = { ...rawBlocks[0] };

    for (let i = 1; i < rawBlocks.length; i++) {
      const nextItem = rawBlocks[i];
      
      // Cho phép chênh lệch y lớn hơn để gom các dòng bị lệch nhẹ
      const sameLine = Math.abs(currentLine.y - nextItem.y) < 12;
      
      // Tính toán khoảng cách X giữa kết thúc của currentLine và bắt đầu của nextItem
      const gap = nextItem.x - (currentLine.x + (currentLine.w || 0));
      
      // Ngưỡng chẻ dọc (Vertical Split) dựa trên khoảng trống giữa các cột (mặc định 40)
      const minGap = 40; 
      const isLargeGap = gap > minGap;

      if (sameLine && !isLargeGap) {
        currentLine.t += " " + nextItem.t;
        // Cập nhật chiều rộng tổng cộng của dòng
        currentLine.w = (nextItem.x + (nextItem.w || 0)) - currentLine.x;
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

function extractCompleteObjects(jsonString: string): any[] {
  const objects: any[] = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let startIndex = -1;

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (depth === 0) {
          startIndex = i;
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          try {
            const objStr = jsonString.substring(startIndex, i + 1);
            objects.push(JSON.parse(objStr));
          } catch (e) {
            // Ignore parse errors for partial/invalid objects
          }
          startIndex = -1;
        }
      }
    }
  }

  return objects;
}

// State to persist across calls in the same session
const sessionState = {
  apiKeys: [] as string[],
  currentKeyIndex: 0,
  currentModelIndex: 0,
  isInitialized: false
};

function initializeSession() {
  if (sessionState.isInitialized) return;
  
  const defaultApiKeyStr = process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";
  const customApiKeysStr = process.env.NEXT_PUBLIC_CUSTOM_GEMINI_API_KEYS || "";
  
  let apiKeys: string[] = [];
  
  // Thêm các key custom của người dùng vào trước
  if (customApiKeysStr) {
    const customKeys = customApiKeysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
    apiKeys = [...apiKeys, ...customKeys];
  }
  
  // Thêm key mặc định của hệ thống vào sau cùng
  if (defaultApiKeyStr) {
    const defaultKeys = defaultApiKeyStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
    // Lọc bỏ những key đã có trong customKeys để tránh trùng lặp
    const uniqueDefaultKeys = defaultKeys.filter(k => !apiKeys.includes(k));
    apiKeys = [...apiKeys, ...uniqueDefaultKeys];
  }

  // Đẩy các key mặc định của AI Studio (thường bắt đầu bằng AIzaSyD8) xuống cuối danh sách
  apiKeys.sort((a, b) => {
    const isDefaultA = a.startsWith('AIzaSyD8');
    const isDefaultB = b.startsWith('AIzaSyD8');
    if (isDefaultA === isDefaultB) return 0;
    return isDefaultA ? 1 : -1;
  });

  sessionState.apiKeys = apiKeys;
  sessionState.isInitialized = true;
  console.log(`[DEBUG] Session initialized with ${apiKeys.length} keys:`, apiKeys.map(k => k.substring(0, 8) + '...'));
}

/**
 * Bước 2 & 3: Gọi API Gemini để xử lý bài báo (Hybrid: HLA Zones + Text)
 */
export async function extractArticlesHybrid(
  zones: HLAZone[],
  pageNumber: number,
  fileName: string,
  base64Image?: string,
  onArticleParsed?: (article: Article) => void
): Promise<Article[]> {
  console.log("--- [DEBUG] extractArticlesHybrid called ---");
  
  initializeSession();
  const { apiKeys } = sessionState;

  if (apiKeys.length === 0) {
    throw new Error("No valid API keys found. Please configure NEXT_PUBLIC_CUSTOM_GEMINI_API_KEYS or NEXT_PUBLIC_GEMINI_API_KEY.");
  }
  
  // Làm sạch dữ liệu gửi đi: Loại bỏ header/footer của trang khác và chỉ giữ lại zone bài báo
  // Bao gồm cả zone 'unknown' để tránh bỏ sót nội dung
  const cleanedZones = zones
    .filter(zone => zone.type === 'article' || zone.type === 'unknown')
    .map(zone => {
      return {
        ...zone,
        blocks: zone.blocks
          .filter(b => b.text.trim().length > 0)
      };
    }).filter(zone => zone.blocks.length > 0);

  const optimizedZones = cleanedZones.map(zone => ({
    id: zone.id,
    blocks: zone.blocks.map(b => ({
      t: b.text,
      fs: b.fontSize,
      b: b.isBold,
      l: b.label,
      ind: b.isIndented
    }))
  }));

  const jsonPayload = JSON.stringify(optimizedZones);
  console.log(`[DEBUG] JSON Payload size: ${(new Blob([jsonPayload]).size / 1024).toFixed(2)} KB (Zones: ${cleanedZones.length})`);
  // console.log(`[DEBUG] JSON Payload:`, jsonPayload);

  const prompt = `
  Bạn là chuyên gia biên tập báo chí. Nhiệm vụ: Trích xuất và sắp xếp lại nội dung thành các bài báo hoàn chỉnh từ JSON zones.
  
  QUY TẮC QUAN TRỌNG:
  1. KHÔNG tóm tắt, KHÔNG sửa nội dung, KHÔNG bỏ sót bất kỳ đoạn văn nào thuộc về bài báo.
  2. Gộp Sapo/Tít phụ vào Content. Sapo thường là đoạn văn có font chữ lớn hơn hoặc in đậm, nằm ngay dưới hoặc bên cạnh tiêu đề chính.
  3. Loại bỏ Header/Footer (thường là tên báo, ngày tháng, số trang ở rìa trang). Tuy nhiên, CẨN THẬN không nhầm lẫn đoạn văn đầu tiên của bài báo với Header.
  4. Giữ nguyên tiêu đề bài báo. KHÔNG tự ý thêm dấu hai chấm (:) hay bất kỳ ký tự nào vào tiêu đề hoặc nội dung.
  5. Các thành phần trong một khối tin bài sẽ luôn được gom trong phạm vi một hình tứ giác (hình vuông hoặc hình chữ nhật). Hãy sử dụng đặc điểm không gian này để nhóm các khối văn bản chính xác. Lưu ý rằng bài báo có thể có bố cục phức tạp, ví dụ: cột nội dung đầu tiên có thể bắt đầu ngang hàng với tiêu đề chính hoặc thậm chí nằm phía trên tiêu đề chính trong một số trường hợp.
  6. Nếu một đoạn văn trông giống Caption nhưng chứa nội dung dẫn dắt câu chuyện, hãy giữ lại trong Content.
  7. Đảm bảo trích xuất ĐẦY ĐỦ 100% văn bản của bài báo. Tuyệt đối không bỏ qua đoạn văn đầu tiên của bài báo.
  8. Tìm các chỉ dẫn chuyển trang (ví dụ: "(Xem tiếp trang 5)", "(Tiếp theo trang 1)") và đưa vào trường seePage.
  9. ĐẶC BIỆT CHÚ Ý: Các bài báo thường có chữ cái in hoa rất lớn ở đầu đoạn (Dropcap). Chữ cái này có thể bị tách rời về mặt đồ họa hoặc nằm trong một block riêng biệt. Bạn BẮT BUỘC phải tìm chữ cái này và ghép nó vào đúng vị trí của từ đầu tiên trong đoạn văn. Tuyệt đối không được bỏ sót ký tự Dropcap.
  10. Tít phụ (Sub-headlines) nằm trong cột nội dung phải được giữ nguyên vị trí trong mảng content, không được đưa lên làm tiêu đề chính.
  
  DỮ LIỆU ZONES (JSON):
  ${jsonPayload}
  `;

  console.time("GeminiAPITime");
  
  const modelsToTry = [
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview"
  ];

  let finalArticles: Article[] = [];
  let success = false;
  let lastError: any = null;

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

  for (let k = sessionState.currentKeyIndex; k < apiKeys.length; k++) {
    const apiKey = apiKeys[k];
    const startM = (k === sessionState.currentKeyIndex) ? sessionState.currentModelIndex : 0;
    
    for (let m = startM; m < modelsToTry.length; m++) {
      const model = modelsToTry[m];
      const ai = new GoogleGenAI({ apiKey });
      try {
        console.log(`Đang thử model: ${model} với key: ${apiKey.substring(0, 8)}... (KeyIndex: ${k}, ModelIndex: ${m})`);
        const responseStream = await ai.models.generateContentStream({
          model: model,
          contents: contents,
          config: {
            temperature: 0,
            responseMimeType: "application/json",
            thinkingConfig: { 
              thinkingLevel: model === "gemini-3.1-pro-preview" ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL 
            },
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
                  seePage: { type: Type.STRING },
                  imageCaption: { type: Type.STRING }
                },
                required: ["title", "content"]
              }
            },
          },
        });

        let fullText = "";
        const emittedIds = new Set<string>();
        finalArticles = []; // Reset for each model attempt

        for await (const chunk of responseStream) {
          if (chunk.text) {
            fullText += chunk.text;
            
            const parsedObjects = extractCompleteObjects(fullText);
            
            for (let i = 0; i < parsedObjects.length; i++) {
              const art = parsedObjects[i];
              const id = `${fileName}-${pageNumber}-${i}`;
              
              if (!emittedIds.has(id)) {
                emittedIds.add(id);
                
                const article: Article = {
                  id,
                  title: art.title && art.title !== 'null' ? art.title : "Không có tiêu đề",
                  author: art.author && art.author !== 'null' ? art.author : "",
                  lead: art.lead && art.lead !== 'null' ? art.lead : "",
                  content: (Array.isArray(art.content) ? art.content : [])
                    .map((p: string) => p.trim())
                    .filter((p: string) => p.length > 0 && p !== 'null'),
                  imageCaption: art.imageCaption && art.imageCaption !== 'null' ? art.imageCaption : "",
                  seePage: art.seePage && art.seePage !== 'null' ? art.seePage : "",
                  pageNumbers: [pageNumber],
                  fileName: fileName,
                  articleRegionId: ""
                };
                
                finalArticles.push(article);
                if (onArticleParsed) {
                  onArticleParsed(article);
                }
              }
            }
          }
        }
        
        // Lưu lại trạng thái đang hoạt động tốt
        sessionState.currentKeyIndex = k;
        sessionState.currentModelIndex = m;
        success = true;
        break; // Thoát khỏi vòng lặp model nếu thành công
      } catch (error: any) {
        console.error(`Lỗi với model ${model} (Key: ${apiKey.substring(0, 8)}...):`, error);
        lastError = error;
        
        const isQuotaError = error?.status === 429 || error?.status === "RESOURCE_EXHAUSTED" || error?.message?.includes("429") || error?.message?.includes("quota");
        
        if (isQuotaError) {
          console.log(`Model ${model} với key ${apiKey.substring(0, 8)}... hết quota, chuyển sang model tiếp theo...`);
          continue; // Thử model tiếp theo
        } else {
          console.log(`Lỗi không phải do quota, chuyển sang model tiếp theo...`);
          continue; // Thử model tiếp theo
        }
      }
    }
    
    if (success) {
      break; // Thoát khỏi vòng lặp key nếu thành công
    } else {
      // Nếu hết model của key này mà vẫn chưa thành công, reset model index về 0 cho key tiếp theo
      sessionState.currentModelIndex = 0;
    }
  }

  console.timeEnd("GeminiAPITime");

  if (!success) {
    sessionState.currentKeyIndex = 0;
    sessionState.currentModelIndex = 0;
    throw new QuotaExhaustedError("Thành thật xin lỗi! Hiện đã hết quota Gemini để xử lý. Xin chờ đến hôm sau mình làm tiếp nhé!", finalArticles);
  }

  return finalArticles;
}
