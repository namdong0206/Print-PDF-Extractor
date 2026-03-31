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
  l?: string; // label (from HLA)
  ind?: boolean; // is_indented
}

export interface Article {
  id: string;
  articleRegionId: string;
  title: string;
  author: string;
  content: string[];
  imageCaption: string;
  seePage: string;
  pageNumbers: number[];
  fileName?: string;
}

export function mergeArticles(articles: Article[]): Article[] {
  const merged: Article[] = [];
  
  const normalize = (s: string) => s.toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Hàm kiểm tra độ tương đồng phần đầu (ít nhất 80%)
  const isSimilarTitle = (t1: string, t2: string) => {
    const s1 = normalize(t1);
    const s2 = normalize(t2);
    if (s1 === s2) return true;
    
    const minLen = Math.min(s1.length, s2.length);
    if (minLen < 10) return s1 === s2; // Tiêu đề quá ngắn thì yêu cầu khớp chính xác

    // Kiểm tra xem phần chung ở đầu có chiếm ít nhất 80% chiều dài của tiêu đề ngắn hơn không
    let commonPrefixLen = 0;
    for (let i = 0; i < minLen; i++) {
      if (s1[i] === s2[i]) commonPrefixLen++;
      else break;
    }
    
    return (commonPrefixLen / minLen) >= 0.8;
  };

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
    return content.filter(para => {
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
  };

  for (const article of articles) {
    let existingIndex = merged.findIndex(a => isSimilarTitle(a.title, article.title));
    
    if (existingIndex === -1) {
      // Try to match by seePage cues if title matching fails
      existingIndex = merged.findIndex(a => {
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
      const isArticleContinuation = /tiếp theo trang|tiếp từ trang/i.test(article.seePage || "");
      const isArticleStart = /xem trang|xem tiếp trang/i.test(article.seePage || "");
      
      const isExistingContinuation = /tiếp theo trang|tiếp từ trang/i.test(existing.seePage || "");
      const isExistingStart = /xem trang|xem tiếp trang/i.test(existing.seePage || "");

      let append = true;
      
      if (isArticleContinuation && isExistingStart) {
        // Article là phần tiếp theo, Existing là phần đầu -> Append
        append = true;
      } else if (isArticleStart && isExistingContinuation) {
        // Article là phần đầu, Existing là phần tiếp theo -> Prepend
        append = false;
      } else {
        // Fallback to page number nếu không có cue rõ ràng
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
  
  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("NEXT_PUBLIC_GEMINI_API_KEY is not set. Please configure it in your environment variables.");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  
  // Làm sạch dữ liệu gửi đi: Loại bỏ header/footer của trang khác khỏi các block
  const cleanedZones = zones.map(zone => {
    return {
      ...zone,
      blocks: zone.blocks
        .map(b => ({
          ...b,
          text: b.text.replace(/CHÍNH TRỊ\s+\d+\/\d+\/\d+\s+\d+/gi, '').trim()
        }))
        .filter(b => b.text.length > 0)
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
  console.log(`Kích thước gửi: ${(new Blob([jsonPayload]).size / 1024).toFixed(2)} KB (Zones: ${zones.length})`);

  const prompt = `
  Bạn là chuyên gia biên tập báo chí chuyên nghiệp. 
  Đầu vào là:
  1. Hình ảnh trang báo (để bạn thấy luồng đọc, đường kẻ, ảnh).
  2. Danh sách các vùng bài báo (Zones) đã được phân tách sơ bộ dưới dạng JSON.

  Nhiệm vụ: Đối chiếu hình ảnh với dữ liệu JSON để sắp xếp lại nội dung thành các bài báo hoàn chỉnh.
  
  QUY TẮC NGHIÊM NGẶT:
  1. CHỈ XỬ LÝ NỘI DUNG TRANG HIỆN TẠI: Tuyệt đối không xử lý nội dung thuộc về các trang khác (ví dụ: Header, Footer, Tiêu đề bài báo của trang sau). Nếu thấy nội dung này, hãy bỏ qua hoàn toàn.
  2. GIỮ NGUYÊN VĂN NỘI DUNG: Tuyệt đối giữ nguyên văn nội dung từ các block, KHÔNG được tóm tắt, KHÔNG viết lại, KHÔNG sửa đổi bất kỳ từ ngữ nào. Nhiệm vụ duy nhất là sắp xếp các đoạn văn theo đúng thứ tự đọc logic.
  3. NHẬN DIỆN BÀI NỐI TRANG: 
     - Tìm các chỉ dẫn "XEM TRANG ..." hoặc "Xem tiếp trang ..." ở cuối bài báo (thường là phần đầu của bài).
     - Tìm các chỉ dẫn "Tiếp theo trang ..." hoặc "Tiếp từ trang ..." ở đầu bài báo (thường là phần tiếp theo ở trang khác).
     - Lưu các chỉ dẫn này vào trường "seePage".
     - TUYỆT ĐỐI KHÔNG bao gồm các chỉ dẫn này trong mảng "content".
  4. TIÊU ĐỀ BÀI NỐI: Tiêu đề ở các trang khác nhau của cùng một bài báo sẽ rất giống nhau (ít nhất 80% phần đầu). Hãy giữ nguyên tiêu đề gốc để hệ thống có thể ghép lại. Nếu bài báo là phần tiếp theo từ trang trước, hãy trích xuất chính xác tiêu đề của bài báo đó (thường được in đậm hoặc in hoa nhỏ ở đầu phần tiếp theo) để làm "title".
  5. GỘP SAPO VÀ TÍT PHỤ VÀO CONTENT: KHÔNG tách riêng Sapo (Lead) hay Tít phụ (Subtitle). Hãy gộp toàn bộ Sapo, Tít phụ và Nội dung bài viết vào chung mảng "content" theo đúng thứ tự đọc từ trên xuống dưới. Điều này rất quan trọng để tránh đảo lộn thứ tự.
  6. GIỮ LẠI chú thích ảnh (Caption) và gán vào trường "imageCaption". LOẠI BỎ: Header, Footer, Quảng cáo, Số trang. LƯU Ý: Tuyệt đối không loại bỏ tiêu đề bài báo (Headline) ngay cả khi nó nằm gần hoặc cùng vùng với Header/Footer.
  7. Ghép các đoạn văn (Content) theo đúng thứ tự logic. Nếu một bài bị chia ra nhiều Zone trong cùng 1 trang, hãy ghép lại ngay.
  8. KHÔNG lặp lại Tiêu đề (Title) trong phần Nội dung (Content).
  
  DỮ LIỆU ZONES (JSON):
  ${jsonPayload}
  `;

  console.time("GeminiAPITime");
  
  const MODEL = "gemini-3-flash-preview";

  try {
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

    const responseStream = await ai.models.generateContentStream({
      model: MODEL,
      contents: contents,
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
    const emittedIds = new Set<string>();
    const finalArticles: Article[] = [];

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
              title: art.title || "Không có tiêu đề",
              author: art.author || "",
              content: (Array.isArray(art.content) ? art.content : [])
                .map((p: string) => p.trim())
                .filter((p: string) => p.length > 0),
              imageCaption: art.imageCaption || "",
              seePage: art.seePage || "",
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

    console.timeEnd("GeminiAPITime");
    return finalArticles;
  } catch (error) {
    console.timeEnd("GeminiAPITime");
    console.error("Error in extractArticlesHybrid:", error);
    throw error;
  }
}
