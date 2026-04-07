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
  content: string[];
  imageCaption: string[];
  seePage: string;
  pageNumbers: number[];
  fileName?: string;
  note?: string;
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
      
      // Check if it's an unmatched continuation
      const isArticleContinuation = /tiếp theo trang|tiếp từ trang|tiếp theo/i.test(article.seePage || "");
      
      // Check if it's a header-only article (no content)
      const isHeaderOnly = newArt.content.length === 0 || (newArt.content.length === 1 && newArt.content[0].trim() === "");
      
      if (isArticleContinuation && !isHeaderOnly) {
        newArt.note = "Bài không ghép được do không tìm thấy phần còn lại...";
      } else {
        newArt.note = newArt.note || "";
      }
      
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
      
      // Ngưỡng chẻ dọc (Vertical Split) dựa trên khoảng trống giữa các cột (mặc định 20)
      const minGap = 20; 
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
      const sameColumn = Math.abs(currentPara.x - nextLine.x) < 30;
      // Khoảng cách dòng (y gần nhau)
      const closeVertical = Math.abs(nextLine.y - (currentPara.y + currentPara.fs)) < 30;
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

let cachedApiKeys: string[] | null = null;

function getSortedApiKeys(): string[] {
  if (cachedApiKeys) return cachedApiKeys;

  const defaultApiKeyStr = process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";
  const customApiKeysStr = process.env.NEXT_PUBLIC_CUSTOM_GEMINI_API_KEYS || "";
  
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

  apiKeys.sort((a, b) => {
    const isDefaultA = a.startsWith('AIzaSyD8');
    const isDefaultB = b.startsWith('AIzaSyD8');
    
    if (isDefaultA === isDefaultB) return 0;
    return isDefaultA ? 1 : -1;
  });

  if (apiKeys.length === 0) {
    throw new Error("No valid API keys found. Please configure NEXT_PUBLIC_CUSTOM_GEMINI_API_KEYS or NEXT_PUBLIC_GEMINI_API_KEY.");
  }
  
  console.log(`[DEBUG] Đã nạp ${apiKeys.length} API keys lần đầu:`, apiKeys.map(k => k.substring(0, 8) + '...'));
  cachedApiKeys = apiKeys;
  return cachedApiKeys;
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
  console.log("--- [DEBUG] extractArticlesHybrid called (calling server-side API) ---");
  
  // Thu thập tất cả các blocks từ tất cả các zones và làm phẳng chúng
  const allBlocks = zones.flatMap(zone => 
    zone.blocks.map(b => ({
      t: b.text,
      x: Math.round(b.bbox.x),
      y: Math.round(b.bbox.y),
      w: Math.round(b.bbox.width),
      h: Math.round(b.bbox.height),
      fs: b.fontSize,
      b: b.isBold,
      l: b.label
    }))
  ).filter(b => b.t.trim().length > 0);

  const response = await fetch('/api/extract-articles', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      blocks: allBlocks,
      pageNumber,
      fileName,
      base64Image
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to extract articles from server');
  }

  const { articles } = await response.json();

  // Map to Article type and add missing fields
  const finalArticles: Article[] = articles.map((art: any, i: number) => {
    let author = art.author && art.author !== 'null' ? art.author : "";
    let content = (Array.isArray(art.content) ? art.content : [])
        .map((p: string) => p.trim())
        .filter((p: string) => p.length > 0 && p !== 'null');
    let imageCaptions: string[] = (Array.isArray(art.imageCaption) ? art.imageCaption : [])
        .map((c: string) => c.trim())
        .filter((c: string) => c.length > 0 && c !== 'null');

    // 1. Author Processing
    if (content.length > 0) {
      const firstPara = content[0];
      
      // Case 1: Author in Author field AND at start of Content
      if (author && firstPara.toLowerCase().startsWith(author.toLowerCase())) {
        content[0] = firstPara.substring(author.length).trim().replace(/^[-,: ]+/, '');
      } 
      // Case 2: Author only in Content
      else if (!author) {
        const match = firstPara.match(/^(Bài và ảnh:)\s*(.*)/i);
        if (match) {
          author = match[2].trim();
          content[0] = firstPara.substring(match[0].length).trim();
        }
      }
    }

    // 2. Photo Caption Processing
    const captionRegex = /^(Ảnh:|Ảnh)\s*(.*)/i;
    for (let i = 0; i < content.length; i++) {
      const match = content[i].match(captionRegex);
      if (match) {
        const foundCaption = match[0].trim();
        
        // If we don't have a caption, or this is a new one, update it
        if (imageCaptions.length === 0) {
          imageCaptions.push(foundCaption);
          content.splice(i, 1);
          i--; // Adjust index
        } 
        // If we already have a caption, and it matches, remove from content
        else if (imageCaptions.some(c => c.toLowerCase().includes(foundCaption.toLowerCase()))) {
          content.splice(i, 1);
          i--;
        } else {
          // New caption found
          imageCaptions.push(foundCaption);
          content.splice(i, 1);
          i--;
        }
      }
    }

    let title = art.title && art.title !== 'null' ? art.title : "";
    let note = art.note || "";

    if (!title) {
      title = "Bài không có tiêu đề...";
      note = "Bài không có tiêu đề và không có chỉ dẫn ghép nối";
    }

    const article: Article = {
      id: `${fileName}-${pageNumber}-${i}`,
      articleRegionId: "",
      title: title,
      author: author,
      content: content.filter((p: string) => p.length > 0),
      imageCaption: imageCaptions,
      seePage: art.seePage && art.seePage !== 'null' ? art.seePage : "",
      pageNumbers: [pageNumber],
      fileName: fileName,
      note: note
    };
    
    if (onArticleParsed) {
      onArticleParsed(article);
    }
    return article;
  });

  return finalArticles;
}
