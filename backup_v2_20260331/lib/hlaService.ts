import { TextBlock } from './geminiProcessor';

export interface HLAZone {
  id: string;
  type: 'Headline' | 'Sapo' | 'Author' | 'Content' | 'Caption' | 'Image' | 'Header' | 'Footer' | 'Unknown';
  bbox: { x: number, y: number, w: number, h: number };
  text: string;
  confidence: number;
  fontSize?: number;
  fontName?: string;
  items?: any[];
}

/**
 * Heuristic Layout Analysis (HLA) Service
 * Phân tích bố cục dựa trên các quy tắc hình học và thuộc tính văn bản (font, size, position)
 */

export async function parseNewspaperLayoutHybrid(page: any): Promise<{ zones: HLAZone[] }> {
  // 1. Trích xuất text content và metadata từ PDF
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  
  // 2. Chuyển đổi sang TextBlocks
  let blocks: TextBlock[] = textContent.items.map((item: any, index: number) => {
    const transform = item.transform;
    // transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
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

  // 3. Tiền xử lý: Gộp các block nằm trên cùng một dòng và gần nhau
  blocks = preprocessBlocks(blocks);

  // 4. Phân loại sơ bộ dựa trên heuristic (font size, position)
  const classifiedBlocks = classifyBlocks(blocks, viewport.height);

  // 5. Gom nhóm các block cùng loại nằm gần nhau thành các Zone
  const zones = mergeBlocksIntoZones(classifiedBlocks);

  return { zones };
}

function preprocessBlocks(blocks: TextBlock[]): TextBlock[] {
  if (blocks.length === 0) return [];

  // Sắp xếp theo y (từ trên xuống) rồi đến x (từ trái sang)
  const sorted = [...blocks].sort((a, b) => {
    if (Math.abs(a.bbox.y - b.bbox.y) > 3) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });

  const merged: TextBlock[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    
    // Kiểm tra xem có cùng dòng (y tương đương) và khoảng cách x nhỏ không
    const sameLine = Math.abs(current.bbox.y - next.bbox.y) < 3;
    const closeX = next.bbox.x - (current.bbox.x + current.bbox.w) < 8; // Giảm ngưỡng để tránh gộp nhầm cột
    const sameFont = current.fontName === next.fontName && Math.abs(current.fontSize - next.fontSize) < 1;

    // Loại bỏ các block trùng lặp hoàn toàn về nội dung và vị trí (thường do PDF render lỗi)
    const isDuplicate = sameLine && Math.abs(current.bbox.x - next.bbox.x) < 2 && current.text === next.text;
    if (isDuplicate) continue;

    if (sameLine && closeX && sameFont) {
      // Gộp text
      current.text += (current.text.endsWith(' ') || next.text.startsWith(' ') ? '' : ' ') + next.text;
      // Cập nhật bounding box
      current.bbox.w = (next.bbox.x + next.bbox.w) - current.bbox.x;
      current.bbox.h = Math.max(current.bbox.h, next.bbox.h);
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  return merged;
}

function classifyBlocks(blocks: TextBlock[], pageHeight: number): TextBlock[] {
  // Tìm font size phổ biến nhất (thường là body text)
  const fontSizes = blocks.map(b => Math.round(b.fontSize));
  const counts: Record<number, number> = {};
  fontSizes.forEach(s => counts[s] = (counts[s] || 0) + 1);
  
  let bodyFontSize = 10;
  let maxCount = 0;
  Object.entries(counts).forEach(([size, count]) => {
    if (count > maxCount) {
      maxCount = count;
      bodyFontSize = Number(size);
    }
  });

  return blocks.map(block => {
    const text = block.text.trim();
    const isUpper = text === text.toUpperCase() && text.length > 5;
    const isHeader = block.bbox.y < pageHeight * 0.08;
    const isFooter = block.bbox.y > pageHeight * 0.92;

    // Quy tắc phân loại
    if (isHeader) return { ...block, label: 'Header' };
    if (isFooter) return { ...block, label: 'Footer' };
    
    if (block.fontSize > bodyFontSize * 1.4) {
      return { ...block, label: 'Headline' };
    } else if (block.fontSize > bodyFontSize * 1.1 && (block.fontName?.toLowerCase().includes('bold') || block.fontName?.toLowerCase().includes('medium'))) {
      return { ...block, label: 'Sapo' };
    } else if (block.fontSize < bodyFontSize * 0.9) {
      return { ...block, label: 'Caption' };
    } else if (text.length < 50 && (text.includes('Ảnh:') || text.includes('Bài:') || text.includes('PV'))) {
      return { ...block, label: 'Author' };
    } else {
      return { ...block, label: 'Content' };
    }
  });
}

function mergeBlocksIntoZones(blocks: TextBlock[]): HLAZone[] {
  const zones: HLAZone[] = [];
  const used = new Set<string>();

  blocks.forEach((block, i) => {
    if (used.has(block.id)) return;

    const currentZone: HLAZone = {
      id: `zone-${zones.length}`,
      type: block.label as any,
      bbox: { ...block.bbox },
      text: block.text,
      confidence: 0.8,
      fontSize: block.fontSize,
      fontName: block.fontName,
      items: [block]
    };
    used.add(block.id);

    // Tìm các block lân cận cùng loại để gộp
    let foundMore = true;
    while (foundMore) {
      foundMore = false;
      for (let j = 0; j < blocks.length; j++) {
        const next = blocks[j];
        if (used.has(next.id)) continue;

        // Điều kiện gộp: cùng loại và khoảng cách y nhỏ, có sự chồng lấp x
        const sameType = next.label === currentZone.type;
        const verticalGap = next.bbox.y - (currentZone.bbox.y + currentZone.bbox.h);
        const isClose = verticalGap >= -5 && verticalGap < 20;
        
        // Kiểm tra chồng lấp x (x-overlap)
        const xOverlap = Math.min(currentZone.bbox.x + currentZone.bbox.w, next.bbox.x + next.bbox.w) - 
                         Math.max(currentZone.bbox.x, next.bbox.x);
        const hasXOverlap = xOverlap > 0 || Math.abs(currentZone.bbox.x - next.bbox.x) < 50;

        if (sameType && isClose && hasXOverlap) {
          // Gộp vào zone
          currentZone.text += '\n' + next.text;
          
          // Cập nhật bbox
          const newX = Math.min(currentZone.bbox.x, next.bbox.x);
          const newY = Math.min(currentZone.bbox.y, next.bbox.y);
          const newMaxX = Math.max(currentZone.bbox.x + currentZone.bbox.w, next.bbox.x + next.bbox.w);
          const newMaxY = Math.max(currentZone.bbox.y + currentZone.bbox.h, next.bbox.y + next.bbox.h);
          
          currentZone.bbox = {
            x: newX,
            y: newY,
            w: newMaxX - newX,
            h: newMaxY - newY
          };
          
          currentZone.items?.push(next);
          used.add(next.id);
          foundMore = true;
        }
      }
    }
    zones.push(currentZone);
  });

  return zones;
}
