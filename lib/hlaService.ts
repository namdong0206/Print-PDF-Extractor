import { BoundingBox } from './types';
import { VectorData, VectorLine, VectorRect, VectorImage } from './vectorService';

export interface HLAZone {
  id: string;
  bbox: { x: number; y: number; width: number; height: number };
  blocks: HLABlock[];
  type: 'article' | 'advertisement' | 'header' | 'footer' | 'unknown';
}

export interface HLABlock {
  id: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  fontSize: number;
  fontName: string;
  isBold: boolean;
  isIndented: boolean;
  label: string;
}

/**
 * Hybrid Layout Analysis Service
 */
export class HLAService {
  private baseFontSize: number = 10;

  /**
   * Phân tích layout trang báo
   */
  async analyze(
    textItems: any[],
    vectorData: VectorData,
    pageWidth: number,
    pageHeight: number
  ): Promise<HLAZone[]> {
    // 1. Xác định Font cơ sở (Base Font Size)
    this.calculateBaseFontSize(textItems);

    // 2. Tiền xử lý text blocks (Nhóm dòng, nhận diện thụt lề)
    const blocks = this.preprocessBlocks(textItems);

    // 3. Phân tích bố cục bằng thuật toán XY-Cut tích hợp đường kẻ vector
    const zones = this.xyCut(blocks, vectorData, pageWidth, pageHeight);

    // 4. Phân loại và gán nhãn cho các block trong từng zone (Heuristics)
    this.classifyBlocks(zones, vectorData.images);

    // 5. Gom các block cùng nhãn trong cùng một zone để tối ưu hóa dữ liệu
    this.mergeBlocksInZones(zones);

    return zones;
  }

  /**
   * Gom các block cùng nhãn nằm cạnh nhau trong một zone
   */
  private mergeBlocksInZones(zones: HLAZone[]) {
    zones.forEach(zone => {
      if (zone.blocks.length <= 1) return;

      const merged: HLABlock[] = [];
      let current = { ...zone.blocks[0] };

      for (let i = 1; i < zone.blocks.length; i++) {
        const next = zone.blocks[i];

        // Điều kiện gom: Cùng nhãn, khoảng cách dọc gần nhau
        const sameLabel = current.label === next.label;
        const closeVertical = Math.abs(next.bbox.y - (current.bbox.y + current.bbox.height)) < 15;
        
        // Headline thường có thể gom rộng hơn
        const isHeadline = current.label === 'Headline';
        const verticalThreshold = isHeadline ? 25 : 15;

        if (sameLabel && Math.abs(next.bbox.y - (current.bbox.y + current.bbox.height)) < verticalThreshold) {
          current.text += " " + next.text;
          const newMaxX = Math.max(current.bbox.x + current.bbox.width, next.bbox.x + next.bbox.width);
          const newMaxY = Math.max(current.bbox.y + current.bbox.height, next.bbox.y + next.bbox.height);
          current.bbox.x = Math.min(current.bbox.x, next.bbox.x);
          current.bbox.y = Math.min(current.bbox.y, next.bbox.y);
          current.bbox.width = newMaxX - current.bbox.x;
          current.bbox.height = newMaxY - current.bbox.y;
        } else {
          merged.push(current);
          current = { ...next };
        }
      }
      merged.push(current);
      zone.blocks = merged;
    });
  }

  /**
   * Tính toán font size phổ biến nhất (Body Text)
   */
  private calculateBaseFontSize(items: any[]) {
    const counts: Record<number, number> = {};
    items.forEach(item => {
      const size = Math.round(item.fontSize);
      counts[size] = (counts[size] || 0) + 1;
    });

    let maxCount = 0;
    let baseSize = 10;
    for (const size in counts) {
      if (counts[size] > maxCount) {
        maxCount = counts[size];
        baseSize = parseInt(size);
      }
    }
    this.baseFontSize = baseSize;
  }

  /**
   * Nhóm các text items thành dòng và nhận diện thụt lề
   */
  private preprocessBlocks(items: any[]): HLABlock[] {
    // 1. Loại bỏ các item trùng lặp (thường xảy ra trong PDF có shadow/effects)
    // Sử dụng sai số 1pt cho tọa độ để bắt các item gần như trùng khít
    const uniqueItems: any[] = [];
    const seen = new Set<string>();
    
    items.forEach(item => {
      const rx = Math.round(item.x);
      const ry = Math.round(item.y);
      const key = `${item.text}_${rx}_${ry}`;
      
      // Kiểm tra cả các vị trí lân cận 1px
      let isDuplicate = false;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (seen.has(`${item.text}_${rx + dx}_${ry + dy}`)) {
            isDuplicate = true;
            break;
          }
        }
        if (isDuplicate) break;
      }

      if (!isDuplicate) {
        seen.add(key);
        uniqueItems.push(item);
      }
    });

    // 2. Sắp xếp theo Y (trên xuống), sau đó X (trái sang)
    const sorted = [...uniqueItems].sort((a, b) => 
      Math.abs(a.y - b.y) < 3 ? a.x - b.x : a.y - b.y
    );

    const lines: any[][] = [];
    if (sorted.length === 0) return [];

    let currentLine = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      
      // Ngưỡng khoảng cách ngang để coi là cùng một khối văn bản
      // Đối với báo in, máng xối thường > 10pt. Khoảng cách chữ thường < 0.5 * fontSize.
      // Sử dụng 0.8 * fontSize làm ngưỡng an toàn để không gộp qua cột.
      const horizontalGapThreshold = Math.max(prev.fontSize, curr.fontSize) * 0.8;
      
      const sameLine = Math.abs(curr.y - prev.y) < 3;
      const closeX = curr.x - (prev.x + prev.width) < horizontalGapThreshold;

      if (sameLine && closeX) {
        currentLine.push(curr);
      } else {
        lines.push(currentLine);
        currentLine = [curr];
      }
    }
    lines.push(currentLine);

    // Xác định lề trái chuẩn của trang (hoặc cột - sẽ xử lý sau trong XY-Cut)
    // Tạm thời lấy lề trái phổ biến nhất
    const xStarts: Record<number, number> = {};
    lines.forEach(line => {
      const x = Math.round(line[0].x);
      xStarts[x] = (xStarts[x] || 0) + 1;
    });

    return lines.map((line, idx) => {
      const x = Math.min(...line.map(i => i.x));
      const y = Math.min(...line.map(i => i.y));
      const maxX = Math.max(...line.map(i => i.x + i.width));
      const maxY = Math.max(...line.map(i => i.y + i.height));
      const text = line.map(i => i.text).join(' ');
      const fontSize = Math.max(...line.map(i => i.fontSize));
      
      return {
        id: `block-${idx}`,
        text,
        bbox: { x, y, width: maxX - x, height: maxY - y },
        fontSize,
        fontName: line[0].fontName,
        isBold: line[0].isBold,
        isIndented: false, // Sẽ được cập nhật sau khi biết lề cột
        label: 'unknown'
      };
    });
  }

  /**
   * Thuật toán XY-Cut đệ quy
   */
  private xyCut(
    blocks: HLABlock[],
    vectorData: VectorData,
    width: number,
    height: number
  ): HLAZone[] {
    const zones: HLAZone[] = [];
    
    // Khởi tạo root zone
    const root: HLAZone = {
      id: 'root',
      bbox: { x: 0, y: 0, width, height },
      blocks,
      type: 'unknown'
    };

    const split = (zone: HLAZone, depth: number): HLAZone[] => {
      if (depth > 10 || zone.blocks.length <= 1) return [zone];

      // Thử cắt dọc (Vertical Cut - Chia cột)
      const vGaps = this.findGaps(zone, 'V', vectorData.lines);
      if (vGaps.length > 0) {
        // Ưu tiên các gap rộng hơn (máng xối)
        const sortedGaps = vGaps.sort((a, b) => b.width - a.width);
        const bestGap = sortedGaps[0];
        
        // Chỉ cắt nếu gap đủ rộng hoặc có đường kẻ phân tách
        if (bestGap.width > 8) {
          const leftBlocks = zone.blocks.filter(b => b.bbox.x + b.bbox.width <= bestGap.start + 2);
          const rightBlocks = zone.blocks.filter(b => b.bbox.x >= bestGap.start + bestGap.width - 2);
          
          if (leftBlocks.length > 0 && rightBlocks.length > 0) {
            const leftZone: HLAZone = {
              id: `${zone.id}-L`,
              bbox: { ...zone.bbox, width: bestGap.start - zone.bbox.x },
              blocks: leftBlocks,
              type: 'unknown'
            };
            const rightZone: HLAZone = {
              id: `${zone.id}-R`,
              bbox: { ...zone.bbox, x: bestGap.start + bestGap.width, width: zone.bbox.x + zone.bbox.width - (bestGap.start + bestGap.width) },
              blocks: rightBlocks,
              type: 'unknown'
            };
            return [...split(leftZone, depth + 1), ...split(rightZone, depth + 1)];
          }
        }
      }

      // Thử cắt ngang (Horizontal Cut - Chia bài báo/khối)
      const hGaps = this.findGaps(zone, 'H', vectorData.lines);
      if (hGaps.length > 0) {
        const bestGap = hGaps.sort((a, b) => b.width - a.width)[0];
        const topBlocks = zone.blocks.filter(b => b.bbox.y + b.bbox.height <= bestGap.start);
        const bottomBlocks = zone.blocks.filter(b => b.bbox.y >= bestGap.start + bestGap.width);

        if (topBlocks.length > 0 && bottomBlocks.length > 0) {
          const topZone: HLAZone = {
            id: `${zone.id}-T`,
            bbox: { ...zone.bbox, height: bestGap.start - zone.bbox.y },
            blocks: topBlocks,
            type: 'unknown'
          };
          const bottomZone: HLAZone = {
            id: `${zone.id}-B`,
            bbox: { ...zone.bbox, y: bestGap.start + bestGap.width, height: zone.bbox.y + zone.bbox.height - (bestGap.start + bestGap.width) },
            blocks: bottomBlocks,
            type: 'unknown'
          };
          return [...split(topZone, depth + 1), ...split(bottomZone, depth + 1)];
        }
      }

      return [zone];
    };

    return split(root, 0);
  }

  private findGaps(zone: HLAZone, direction: 'H' | 'V', lines: VectorLine[]) {
    const gaps: { start: number, width: number }[] = [];
    const size = direction === 'V' ? zone.bbox.width : zone.bbox.height;
    const offset = direction === 'V' ? zone.bbox.x : zone.bbox.y;
    
    // Chiếu các block lên trục
    const occupied = new Array(Math.ceil(size)).fill(false);
    zone.blocks.forEach(b => {
      const start = Math.floor((direction === 'V' ? b.bbox.x : b.bbox.y) - offset);
      const end = Math.ceil((direction === 'V' ? b.bbox.x + b.bbox.width : b.bbox.y + b.bbox.height) - offset);
      for (let i = Math.max(0, start); i < Math.min(size, end); i++) occupied[i] = true;
    });

    // Tìm các khoảng trống
    let gapStart = -1;
    for (let i = 0; i < occupied.length; i++) {
      if (!occupied[i]) {
        if (gapStart === -1) gapStart = i;
      } else {
        if (gapStart !== -1) {
          const gapWidth = i - gapStart;
          if (gapWidth > (direction === 'V' ? 10 : 8)) { // Ngưỡng tối thiểu cho máng xối/khoảng cách bài
            gaps.push({ start: gapStart + offset, width: gapWidth });
          }
          gapStart = -1;
        }
      }
    }

    // Tích hợp đường kẻ vector
    lines.forEach(line => {
      if (line.type === direction) {
        // Kiểm tra xem đường kẻ có nằm trong zone không
        const isInside = direction === 'V' 
          ? (line.x1 >= zone.bbox.x && line.x1 <= zone.bbox.x + zone.bbox.width)
          : (line.y1 >= zone.bbox.y && line.y1 <= zone.bbox.y + zone.bbox.height);
        
        if (isInside) {
          const pos = direction === 'V' ? line.x1 : line.y1;
          // Ưu tiên đường kẻ bằng cách tạo một gap ảo tại vị trí đường kẻ
          gaps.push({ start: pos - 2, width: 4 });
        }
      }
    });

    return gaps;
  }

  /**
   * Phân loại các block dựa trên heuristics
   */
  private classifyBlocks(zones: HLAZone[], images: VectorImage[]) {
    zones.forEach(zone => {
      // Xác định lề trái của zone (cột)
      const xStarts: Record<number, number> = {};
      zone.blocks.forEach(b => {
        const x = Math.round(b.bbox.x);
        xStarts[x] = (xStarts[x] || 0) + 1;
      });
      
      let columnLeft = zone.bbox.x;
      let maxCount = 0;
      for (const x in xStarts) {
        if (xStarts[x] > maxCount) {
          maxCount = xStarts[x];
          columnLeft = parseInt(x);
        }
      }

      zone.blocks.forEach(block => {
        // 1. Nhận diện thụt lề (Indentation): Khớp với mô hình 4pt
        if (block.bbox.x > columnLeft + 4 && block.fontSize <= this.baseFontSize + 1) {
          block.isIndented = true;
        }

        // 2. Phân loại theo font size: Title/Sapo > Base + 4pt
        if (block.fontSize > this.baseFontSize + 4) {
          block.label = 'Headline';
        } else if (block.fontSize > this.baseFontSize + 1) {
          block.label = 'Sapo';
        } else if (block.fontSize < this.baseFontSize - 1) {
          block.label = 'Caption';
        } else {
          block.label = 'Content';
        }

        // 3. Magnetic Zone cho Caption (Gần ảnh): Khớp với mô hình 30pt dọc, 10pt ngang
        const isNearImage = images.some(img => {
          const distY = block.bbox.y - (img.y + img.height); // Khoảng cách dưới chân ảnh
          const distX = Math.min(
            Math.abs(block.bbox.x - img.x),
            Math.abs((block.bbox.x + block.bbox.width) - (img.x + img.width))
          );
          return distY > -5 && distY < 30 && distX < 10;
        });
        if (isNearImage && block.fontSize <= this.baseFontSize) {
          block.label = 'Caption';
        }

        // 4. Nhận diện Tác giả (Thường ở cuối bài, font nhỏ hoặc in nghiêng/đậm)
        if (block.label === 'Content' && block.text.length < 50 && (block.isBold || block.fontSize < this.baseFontSize)) {
          // Kiểm tra xem có nằm ở cuối zone không
          const isAtBottom = block.bbox.y > zone.bbox.y + zone.bbox.height * 0.7;
          if (isAtBottom) block.label = 'Author';
        }
      });
    });
  }
}
