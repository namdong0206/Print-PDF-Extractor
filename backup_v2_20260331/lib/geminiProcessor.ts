import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { HLAZone } from './hlaService';

export interface TextBlock {
  id: string;
  text: string;
  bbox: { x: number, y: number, w: number, h: number };
  fontSize: number;
  fontName?: string;
  label: string;
}

export interface Article {
  id: string;
  title: string;
  author?: string;
  lead?: string;
  content: string[];
  imageCaption?: string;
  pageNumbers: number[];
  fileName?: string;
}

const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY || '' });

const ARTICLE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Tiêu đề bài báo" },
      author: { type: Type.STRING, description: "Tên tác giả" },
      lead: { type: Type.STRING, description: "Sapo hoặc đoạn dẫn đầu bài báo" },
      content: { 
        type: Type.ARRAY, 
        items: { type: Type.STRING }, 
        description: "Danh sách các đoạn văn bản nội dung bài báo" 
      },
      imageCaption: { type: Type.STRING, description: "Chú thích ảnh đi kèm bài báo" },
      isContinued: { type: Type.BOOLEAN, description: "Bài báo có bị ngắt quãng và tiếp tục ở trang khác không" },
      continuationNote: { type: Type.STRING, description: "Ghi chú về việc tiếp tục (ví dụ: 'Xem trang 7', 'Tiếp theo trang 2')" }
    },
    required: ["title", "content"]
  }
};

/**
 * Ghép các bài báo từ nhiều trang lại với nhau
 */
export function mergeArticles(articles: Article[]): Article[] {
  if (articles.length <= 1) return articles;

  const merged: Article[] = [];
  const processedIndices = new Set<number>();

  // Sắp xếp bài báo theo tiêu đề và số trang để dễ xử lý
  const sorted = [...articles].sort((a, b) => {
    if (a.title !== b.title) return a.title.localeCompare(b.title);
    return a.pageNumbers[0] - b.pageNumbers[0];
  });

  for (let i = 0; i < sorted.length; i++) {
    if (processedIndices.has(i)) continue;

    let current = { ...sorted[i] };
    processedIndices.add(i);

    // Tìm các phần tiếp theo của bài báo này
    for (let j = i + 1; j < sorted.length; j++) {
      if (processedIndices.has(j)) continue;

      const next = sorted[j];
      
      // Kiểm tra tiêu đề tương đồng (có thể có sai lệch nhỏ do OCR/AI)
      const isSameTitle = areTitlesSimilar(current.title, next.title);
      
      if (isSameTitle) {
        // Kiểm tra logic "Xem trang..." và "Tiếp theo trang..."
        const currentHasNext = hasNextPageCue(current.content.join(' '));
        const nextHasPrev = hasPrevPageCue(next.content.join(' '));
        
        // Nếu có dấu hiệu nối trang, hoặc đơn giản là cùng tiêu đề ở trang khác nhau
        if (currentHasNext || nextHasPrev || current.pageNumbers[0] !== next.pageNumbers[0]) {
          // Ghép nội dung
          // Ưu tiên thứ tự: phần có "Xem trang..." đứng trước phần có "Tiếp theo trang..."
          if (currentHasNext && nextHasPrev) {
             current.content = [...current.content, ...next.content];
             current.pageNumbers = Array.from(new Set([...current.pageNumbers, ...next.pageNumbers])).sort((a, b) => a - b);
          } else if (nextHasPrev && !currentHasNext) {
             // Nếu phần hiện tại là phần tiếp theo, và phần mới tìm thấy là phần trước đó
             current.content = [...next.content, ...current.content];
             current.pageNumbers = Array.from(new Set([...current.pageNumbers, ...next.pageNumbers])).sort((a, b) => a - b);
          } else {
             // Mặc định ghép theo thứ tự trang nếu không rõ ràng
             current.content = [...current.content, ...next.content];
             current.pageNumbers = Array.from(new Set([...current.pageNumbers, ...next.pageNumbers])).sort((a, b) => a - b);
          }
          
          if (!current.author && next.author) current.author = next.author;
          if (!current.lead && next.lead) current.lead = next.lead;
          
          processedIndices.add(j);
        }
      }
    }

    // Làm sạch nội dung: loại bỏ các dòng điều hướng "Xem trang...", "Tiếp theo trang..."
    current.content = current.content.map(p => cleanContent(p)).filter(p => p.length > 0);
    
    merged.push(current);
  }

  return merged;
}

function areTitlesSimilar(t1: string, t2: string): boolean {
  const s1 = t1.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const s2 = t2.toLowerCase().replace(/[^\w\s]/g, '').trim();
  
  if (s1 === s2) return true;
  if (s1.includes(s2) || s2.includes(s1)) return true;
  
  // Levenshtein distance đơn giản hoặc Jaccard similarity có thể thêm ở đây
  return false;
}

function hasNextPageCue(text: string): boolean {
  const patterns = [/xem trang/i, /tiếp trang/i, /còn tiếp/i, /\(trang \d+\)/i];
  return patterns.some(p => p.test(text));
}

function hasPrevPageCue(text: string): boolean {
  const patterns = [/tiếp theo trang/i, /từ trang/i, /tiếp theo kỳ trước/i];
  return patterns.some(p => p.test(text));
}

function cleanContent(text: string): string {
  const patterns = [
    /\(Xem trang \d+\)/gi,
    /\(Tiếp theo trang \d+\)/gi,
    /Xem tiếp trang \d+/gi,
    /Tiếp theo kỳ trước/gi,
    /Tiếp trang \d+/gi
  ];
  
  let cleaned = text;
  patterns.forEach(p => {
    cleaned = cleaned.replace(p, '');
  });
  return cleaned.trim();
}

/**
 * Trích xuất bài báo sử dụng phương pháp Hybrid (HLA + Gemini Multimodal)
 */
export async function extractArticlesHybrid(zones: HLAZone[], pageNum: number, fileName: string, pageImage: string): Promise<Article[]> {
  // Chuẩn bị dữ liệu zone cho Gemini (giảm bớt chi tiết không cần thiết để tiết kiệm token)
  const zoneData = zones.map(z => ({
    type: z.type,
    text: z.text,
    bbox: z.bbox
  }));

  const prompt = `
Bạn là một chuyên gia phân tích layout báo in. Tôi cung cấp cho bạn:
1. Hình ảnh của một trang báo.
2. Danh sách các vùng (zones) đã được nhận diện sơ bộ bằng thuật toán (bao gồm loại vùng, nội dung văn bản và tọa độ).

NHIỆM VỤ CỦA BẠN:
- Phân tích hình ảnh và dữ liệu vùng để xác định các bài báo có trên trang này.
- Nhóm các đoạn văn bản (Content), tiêu đề (Headline), sapo (Sapo), tác giả (Author) và chú thích ảnh (Caption) thuộc về cùng một bài báo.
- Phục dựng thứ tự đọc chính xác của từng bài báo (đọc theo cột, từ trên xuống dưới, từ trái sang phải).
- Loại bỏ hoàn toàn các thành phần không thuộc bài báo: Header, Footer, số trang, quảng cáo, box thông tin rời rạc.
- KHÔNG ĐƯỢC tóm tắt, viết lại hay thay đổi bất kỳ từ ngữ nào trong văn bản gốc.
- Giữ nguyên cấu trúc đoạn văn. Mỗi đoạn văn bản phải là một phần tử trong mảng 'content'.

LƯU Ý ĐẶC BIỆT:
- Một số bài báo có thể có dòng "Xem trang..." hoặc "Tiếp theo trang...". Hãy giữ lại thông tin này trong 'content' để hệ thống có thể ghép bài sau này.
- Nếu một bài báo có nhiều ảnh, hãy gộp các chú thích ảnh lại.

Dữ liệu các vùng:
${JSON.stringify(zoneData)}
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { text: prompt },
            { 
              inlineData: { 
                mimeType: "image/png", 
                data: pageImage.split(',')[1] 
              } 
            }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: ARTICLE_SCHEMA,
        temperature: 0
      }
    });

    const result = JSON.parse(response.text || "[]");
    
    return result.map((item: any, index: number) => ({
      id: `${fileName}-p${pageNum}-a${index}`,
      title: item.title,
      author: item.author,
      lead: item.lead,
      content: item.content,
      imageCaption: item.imageCaption,
      pageNumbers: [pageNum],
      fileName: fileName
    }));
  } catch (error) {
    console.error("Gemini Extraction Error:", error);
    return [];
  }
}

/**
 * Trích xuất text blocks với metadata từ PDF
 */
export async function extractTextBlocksWithMetadata(page: any): Promise<TextBlock[]> {
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  
  return textContent.items.map((item: any, index: number) => {
    const transform = item.transform;
    const x = transform[4];
    const y = viewport.height - transform[5] - (transform[3] || 10);
    const w = item.width;
    const h = transform[3] || 10;

    return {
      id: `item-${index}`,
      text: item.str,
      bbox: { x, y, w, h },
      fontSize: Math.abs(transform[3]),
      fontName: item.fontName,
      label: 'Unknown'
    };
  }).filter((b: any) => b.text.trim().length > 0);
}
