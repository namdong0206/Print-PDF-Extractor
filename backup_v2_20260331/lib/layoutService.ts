import { BoundingBox, ArticleRegion } from './types';

/**
 * Layout Analysis Service
 * Phân tích bố cục báo in sử dụng kết hợp Heuristic (từ PDF metadata) và Image Processing (OpenCV)
 */

export async function parseNewspaperLayout(page: any, image: string): Promise<{ boxes: BoundingBox[], maskImage?: string, cells?: ArticleRegion[] }> {
  // 1. Trích xuất text content từ PDF (Vector data)
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  
  const rawBoxes: BoundingBox[] = textContent.items.map((item: any, index: number) => {
    const transform = item.transform;
    // transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
    const x = transform[4];
    const y = viewport.height - transform[5] - (transform[3] || 10);
    const w = item.width;
    const h = transform[3] || 10;

    return {
      id: `box-${index}`,
      x, y, w, h,
      text: item.str,
      confidence: 1.0,
      label: 'Unknown',
      fontSize: Math.abs(transform[3]),
      fontName: item.fontName
    };
  }).filter((b: any) => b.text.trim().length > 0);

  // 2. Gộp các box nằm trên cùng một dòng và gần nhau (Heuristic)
  const mergedBoxes = mergeBoxesOnSameLine(rawBoxes);

  // 3. Phân loại các box dựa trên font size, position và pattern matching
  const classifiedBoxes = classifyBoxes(mergedBoxes, viewport.height);

  return { boxes: classifiedBoxes };
}

function mergeBoxesOnSameLine(boxes: BoundingBox[]): BoundingBox[] {
  if (boxes.length === 0) return [];

  // Sắp xếp theo y (từ trên xuống) rồi đến x (từ trái sang)
  const sorted = [...boxes].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 3) return a.y - b.y;
    return a.x - b.x;
  });

  const merged: BoundingBox[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    
    // Kiểm tra xem có cùng dòng (y tương đương) và khoảng cách x nhỏ không
    const sameLine = Math.abs(current.y - next.y) < 3;
    const closeX = next.x - (current.x + current.w) < 10;
    const sameFont = current.fontName === next.fontName && Math.abs((current.fontSize || 0) - (next.fontSize || 0)) < 1;

    if (sameLine && closeX && sameFont) {
      // Gộp text
      current.text += (current.text.endsWith(' ') || next.text.startsWith(' ') ? '' : ' ') + next.text;
      // Cập nhật bounding box
      current.w = (next.x + next.w) - current.x;
      current.h = Math.max(current.h, next.h);
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  return merged;
}

function classifyBoxes(boxes: BoundingBox[], pageHeight: number): BoundingBox[] {
  // Tìm font size phổ biến nhất (thường là body text)
  const fontSizes = boxes.map(b => Math.round(b.fontSize || 0));
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

  return boxes.map(box => {
    const text = box.text.trim();
    const isUpper = text === text.toUpperCase() && text.length > 5;
    const isHeader = box.y < pageHeight * 0.08;
    const isFooter = box.y > pageHeight * 0.92;

    // Quy tắc phân loại
    if (isHeader) return { ...box, label: 'Header' };
    if (isFooter) return { ...box, label: 'Footer' };
    
    if ((box.fontSize || 0) > bodyFontSize * 1.4) {
      return { ...box, label: 'Headline' };
    } else if ((box.fontSize || 0) > bodyFontSize * 1.1 && (box.fontName?.toLowerCase().includes('bold') || box.fontName?.toLowerCase().includes('medium'))) {
      return { ...box, label: 'Sapo' };
    } else if ((box.fontSize || 0) < bodyFontSize * 0.9) {
      return { ...box, label: 'Caption' };
    } else if (text.length < 50 && (text.includes('Ảnh:') || text.includes('Bài:') || text.includes('PV'))) {
      return { ...box, label: 'Author' };
    } else {
      return { ...box, label: 'Content' };
    }
  });
}

/**
 * Hybrid Layout Analysis - Phối hợp Heuristic và Gemini
 */
export async function parseNewspaperLayoutHybrid(page: any): Promise<{ zones: any[] }> {
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  
  let blocks: any[] = textContent.items.map((item: any, index: number) => {
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

  // Gộp các block nằm trên cùng một dòng
  blocks = mergeBlocksOnSameLine(blocks);

  // Phân loại sơ bộ
  const classified = classifyBlocks(blocks, viewport.height);

  // Gom nhóm thành các Zone
  const zones = mergeBlocksIntoZones(classified);

  return { zones };
}

function mergeBlocksOnSameLine(blocks: any[]): any[] {
  if (blocks.length === 0) return [];
  const sorted = [...blocks].sort((a, b) => {
    if (Math.abs(a.bbox.y - b.bbox.y) > 3) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });

  const merged: any[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const sameLine = Math.abs(current.bbox.y - next.bbox.y) < 3;
    const closeX = next.bbox.x - (current.bbox.x + current.bbox.w) < 10;
    const sameFont = current.fontName === next.fontName && Math.abs(current.fontSize - next.fontSize) < 1;

    if (sameLine && closeX && sameFont) {
      current.text += (current.text.endsWith(' ') || next.text.startsWith(' ') ? '' : ' ') + next.text;
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

function classifyBlocks(blocks: any[], pageHeight: number): any[] {
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
    const isHeader = block.bbox.y < pageHeight * 0.08;
    const isFooter = block.bbox.y > pageHeight * 0.92;

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

function mergeBlocksIntoZones(blocks: any[]): any[] {
  const zones: any[] = [];
  const used = new Set<string>();

  blocks.forEach((block, i) => {
    if (used.has(block.id)) return;

    const currentZone: any = {
      id: `zone-${zones.length}`,
      type: block.label,
      bbox: { ...block.bbox },
      text: block.text,
      fontSize: block.fontSize,
      fontName: block.fontName,
      items: [block]
    };
    used.add(block.id);

    let foundMore = true;
    while (foundMore) {
      foundMore = false;
      for (let j = 0; j < blocks.length; j++) {
        const next = blocks[j];
        if (used.has(next.id)) continue;

        const sameType = next.label === currentZone.type;
        const verticalGap = next.bbox.y - (currentZone.bbox.y + currentZone.bbox.h);
        const isClose = verticalGap >= -5 && verticalGap < 20;
        const xOverlap = Math.min(currentZone.bbox.x + currentZone.bbox.w, next.bbox.x + next.bbox.w) - 
                         Math.max(currentZone.bbox.x, next.bbox.x);
        const hasXOverlap = xOverlap > 0 || Math.abs(currentZone.bbox.x - next.bbox.x) < 50;

        if (sameType && isClose && hasXOverlap) {
          currentZone.text += '\n' + next.text;
          const newX = Math.min(currentZone.bbox.x, next.bbox.x);
          const newY = Math.min(currentZone.bbox.y, next.bbox.y);
          const newMaxX = Math.max(currentZone.bbox.x + currentZone.bbox.w, next.bbox.x + next.bbox.w);
          const newMaxY = Math.max(currentZone.bbox.y + currentZone.bbox.h, next.bbox.y + next.bbox.h);
          currentZone.bbox = { x: newX, y: newY, w: newMaxX - newX, h: newMaxY - newY };
          currentZone.items.push(next);
          used.add(next.id);
          foundMore = true;
        }
      }
    }
    zones.push(currentZone);
  });

  return zones;
}
