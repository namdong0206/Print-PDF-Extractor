import { BoundingBox } from './types';
import { VectorData, VectorLine, VectorRect, VectorImage, extractVectorData } from './vectorService';

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
  items?: any[]; // Lưu trữ các item gốc để hỗ trợ chẻ dọc nếu cần
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
    let zones = this.xyCut(blocks, vectorData, pageWidth, pageHeight);

    // 4. Chẻ dọc các block bị gộp ngang (Horizontal Merging) - Áp dụng logic từ Python
    zones = this.splitHorizontalMergedZones(zones);

    // Nối Dropcap vào đoạn văn tương ứng
    this.mergeDropcaps(zones);

    // 5. Phân loại và gán nhãn cho các block trong từng zone (Heuristics)
    this.classifyBlocks(zones, vectorData.images);

    // Sắp xếp lại các block trong mỗi zone theo thứ tự đọc (ưu tiên cột)
    zones.forEach(zone => {
      zone.blocks = this.sortBlocksByReadingOrder(zone.blocks);
    });

    // 6. Gom các block cùng nhãn trong cùng một zone để tối ưu hóa dữ liệu
    this.mergeBlocksInZones(zones);

    return zones;
  }

  /**
   * Chẻ dọc các zone/block nếu phát hiện khoảng trống ngang lớn bên trong (Gutter gap) - Đệ quy
   */
  private splitHorizontalMergedZones(zones: HLAZone[]): HLAZone[] {
    const split = (zone: HLAZone): HLAZone[] => {
      const MIN_GAP = 35; // Ngưỡng chẻ dọc
      let splitFound = false;
      let splitX = 0;

      // Tìm điểm chẻ trong các block của zone
      for (const block of zone.blocks) {
        if (!block.items || block.items.length < 2) continue;

        for (let i = 1; i < block.items.length; i++) {
          const prev = block.items[i - 1];
          const curr = block.items[i];
          const gap = curr.x - (prev.x + prev.width);

          if (gap > MIN_GAP) {
            splitX = prev.x + prev.width + (gap / 2);
            splitFound = true;
            break;
          }
        }
        if (splitFound) break;
      }

      if (!splitFound) return [zone];

      // Tiến hành chẻ zone thành Left và Right
      const leftBlocks: HLABlock[] = [];
      const rightBlocks: HLABlock[] = [];

      zone.blocks.forEach(block => {
        if (!block.items) {
          if (block.bbox.x + block.bbox.width / 2 < splitX) leftBlocks.push(block);
          else rightBlocks.push(block);
          return;
        }

        const lItems = block.items.filter(item => {
          const centerX = item.x + item.width / 2;
          return centerX <= splitX;
        });
        const rItems = block.items.filter(item => {
          const centerX = item.x + item.width / 2;
          return centerX > splitX;
        });

        if (lItems.length > 0) {
          leftBlocks.push(this.createBlockFromItems(lItems, `${block.id}-L`));
        }
        if (rItems.length > 0) {
          rightBlocks.push(this.createBlockFromItems(rItems, `${block.id}-R`));
        }
      });

      const result: HLAZone[] = [];
      if (leftBlocks.length > 0) {
        result.push(...split({
          ...zone,
          id: `${zone.id}-SplitL`,
          bbox: this.calculateBBox(leftBlocks),
          blocks: leftBlocks
        }));
      }
      if (rightBlocks.length > 0) {
        result.push(...split({
          ...zone,
          id: `${zone.id}-SplitR`,
          bbox: this.calculateBBox(rightBlocks),
          blocks: rightBlocks
        }));
      }
      return result;
    };

    const finalZones: HLAZone[] = [];
    zones.forEach(z => finalZones.push(...split(z)));
    return finalZones;
  }

  private createBlockFromItems(items: any[], id: string): HLABlock {
    const x = Math.min(...items.map(i => i.x));
    const y = Math.min(...items.map(i => i.y));
    const maxX = Math.max(...items.map(i => i.x + i.width));
    const maxY = Math.max(...items.map(i => i.y + i.height));
    return {
      id,
      text: items.map(i => i.text).join(' '),
      bbox: { x, y, width: maxX - x, height: maxY - y },
      fontSize: Math.max(...items.map(i => i.fontSize)),
      fontName: items[0].fontName,
      isBold: items[0].isBold,
      isIndented: false,
      label: 'unknown',
      items
    };
  }

  private calculateBBox(blocks: HLABlock[]) {
    const x = Math.min(...blocks.map(b => b.bbox.x));
    const y = Math.min(...blocks.map(b => b.bbox.y));
    const maxX = Math.max(...blocks.map(b => b.bbox.x + b.bbox.width));
    const maxY = Math.max(...blocks.map(b => b.bbox.y + b.bbox.height));
    return { x, y, width: maxX - x, height: maxY - y };
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
        
        // Headline thường có thể gom rộng hơn (tăng lên 40pt để bắt các tiêu đề lớn nhiều dòng)
        const isHeadline = current.label === 'Headline';
        const verticalThreshold = isHeadline ? 40 : 15;

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
        label: 'unknown',
        items: line
      };
    });
  }

  /**
   * Sắp xếp các block theo thứ tự đọc thông minh (Column-aware sorting)
   * Tuân thủ nguyên tắc:
   * 1. Khối tiêu đề (Headline) và các phần phụ (Sapo, Caption, PageCue) đọc trước.
   * 2. Các cột nội dung (Content) đọc sau, từ trái sang phải, từ trên xuống dưới.
   */
  private sortBlocksByReadingOrder(blocks: HLABlock[]): HLABlock[] {
    if (blocks.length <= 1) return blocks;

    const headerMetaBlocks: HLABlock[] = [];
    const bodyBlocks: HLABlock[] = [];

    // 1. Phân loại block thành nhóm Header/Meta và nhóm Body (Content)
    blocks.forEach(block => {
      if (['Headline', 'Sapo', 'Caption', 'PageCue'].includes(block.label)) {
        headerMetaBlocks.push(block);
      } else {
        bodyBlocks.push(block);
      }
    });

    // Sắp xếp nhóm Header/Meta từ trên xuống dưới
    headerMetaBlocks.sort((a, b) => a.bbox.y - b.bbox.y);

    // 2. Nhóm bodyBlocks vào các cột ảo dựa trên sự chồng lấp X
    const columns: HLABlock[][] = [];
    // Sắp xếp theo X trước để dễ nhóm
    const sortedByX = [...bodyBlocks].sort((a, b) => a.bbox.x - b.bbox.x);

    sortedByX.forEach(block => {
      let placed = false;
      for (const col of columns) {
        // Lấy phạm vi X của cột hiện tại
        const colX1 = Math.min(...col.map(b => b.bbox.x));
        const colX2 = Math.max(...col.map(b => b.bbox.x + b.bbox.width));
        
        // Tính độ chồng lấp X
        const overlapX = Math.max(0, Math.min(block.bbox.x + block.bbox.width, colX2) - Math.max(block.bbox.x, colX1));
        const minWidth = Math.min(block.bbox.width, colX2 - colX1);
        
        // Nếu chồng lấp > 40% chiều rộng, coi như cùng cột
        if (overlapX > minWidth * 0.4) {
          col.push(block);
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push([block]);
      }
    });

    // 3. Sắp xếp các cột từ trái sang phải
    columns.sort((a, b) => {
      const aX = Math.min(...a.map(b => b.bbox.x));
      const bX = Math.min(...b.map(b => b.bbox.x));
      return aX - bX;
    });

    // 4. Sắp xếp các block trong mỗi cột từ trên xuống dưới
    const sortedBody: HLABlock[] = [];
    columns.forEach(col => {
      col.sort((a, b) => a.bbox.y - b.bbox.y);
      sortedBody.push(...col);
    });

    // 5. Gộp lại: Header/Meta đọc trước, Body đọc sau
    return [...headerMetaBlocks, ...sortedBody];
  }

  /**
   * Phân tích bố cục bằng thuật toán XY-Cut tích hợp đường kẻ vector và hình ảnh
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
      if (depth > 15 || zone.blocks.length <= 1) return [zone];

      // 1. Thử cắt dọc (Vertical Cut - Chia cột)
      const vGaps = this.findGaps(zone, 'V', vectorData.lines, vectorData.images);
      if (vGaps.length > 0) {
        // Ưu tiên các gap rộng hơn (máng xối)
        const sortedGaps = vGaps.sort((a, b) => b.width - a.width);
        const bestGap = sortedGaps[0];
        
        // Chỉ cắt nếu gap đủ rộng hoặc có đường kẻ phân tách
        if (bestGap.width > 6) {
          const leftBlocks = zone.blocks.filter(b => b.bbox.x + b.bbox.width <= bestGap.start + 3);
          const rightBlocks = zone.blocks.filter(b => b.bbox.x >= bestGap.start + bestGap.width - 3);
          
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

      // 2. Thử cắt ngang (Horizontal Cut - Chia bài báo/khối)
      const hGaps = this.findGaps(zone, 'H', vectorData.lines, vectorData.images);
      if (hGaps.length > 0) {
        const bestGap = hGaps.sort((a, b) => b.width - a.width)[0];
        
        // Ngưỡng cắt ngang linh hoạt hơn
        if (bestGap.width > 3) {
          const topBlocks = zone.blocks.filter(b => b.bbox.y + b.bbox.height <= bestGap.start + 1);
          const bottomBlocks = zone.blocks.filter(b => b.bbox.y >= bestGap.start + bestGap.width - 1);

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
      }

      return [zone];
    };

    return split(root, 0);
  }

  private findGaps(zone: HLAZone, direction: 'H' | 'V', lines: VectorLine[], images: VectorImage[]) {
    const gaps: { start: number, width: number }[] = [];
    const size = direction === 'V' ? zone.bbox.width : zone.bbox.height;
    const offset = direction === 'V' ? zone.bbox.x : zone.bbox.y;
    
    // Chiếu các block và hình ảnh lên trục
    const occupied = new Array(Math.ceil(size)).fill(false);
    
    // 1. Đánh dấu vùng bị chiếm bởi văn bản
    zone.blocks.forEach(b => {
      const start = Math.floor((direction === 'V' ? b.bbox.x : b.bbox.y) - offset);
      const end = Math.ceil((direction === 'V' ? b.bbox.x + b.bbox.width : b.bbox.y + b.bbox.height) - offset);
      for (let i = Math.max(0, start); i < Math.min(size, end); i++) occupied[i] = true;
    });

    // 2. Đánh dấu vùng bị chiếm bởi hình ảnh (Rất quan trọng để tránh cắt ngang qua ảnh/cột)
    images.forEach(img => {
      // Kiểm tra xem ảnh có nằm trong phạm vi của zone hiện tại không
      const isIntersecting = direction === 'V'
        ? (img.y < zone.bbox.y + zone.bbox.height && img.y + img.height > zone.bbox.y)
        : (img.x < zone.bbox.x + zone.bbox.width && img.x + img.width > zone.bbox.x);
      
      if (isIntersecting) {
        const start = Math.floor((direction === 'V' ? img.x : img.y) - offset);
        const end = Math.ceil((direction === 'V' ? img.x + img.width : img.y + img.height) - offset);
        for (let i = Math.max(0, start); i < Math.min(size, end); i++) occupied[i] = true;
      }
    });

    // Tìm các khoảng trống
    let gapStart = -1;
    for (let i = 0; i < occupied.length; i++) {
      if (!occupied[i]) {
        if (gapStart === -1) gapStart = i;
      } else {
        if (gapStart !== -1) {
          const gapWidth = i - gapStart;
          // Ngưỡng phát hiện gap: Dọc (cột) cần rộng hơn Ngang (dòng)
          const threshold = direction === 'V' ? 5 : 3;
          if (gapWidth > threshold) { 
            gaps.push({ start: gapStart + offset, width: gapWidth });
          }
          gapStart = -1;
        }
      }
    }
    // Xử lý gap cuối cùng nếu có
    if (gapStart !== -1 && occupied.length - gapStart > (direction === 'V' ? 5 : 3)) {
      gaps.push({ start: gapStart + offset, width: occupied.length - gapStart });
    }

    // Tích hợp đường kẻ vector để ưu tiên điểm cắt
    lines.forEach(line => {
      if (line.type === direction) {
        const isInside = direction === 'V' 
          ? (line.x1 >= zone.bbox.x && line.x1 <= zone.bbox.x + zone.bbox.width && 
             line.y1 < zone.bbox.y + zone.bbox.height && line.y2 > zone.bbox.y)
          : (line.y1 >= zone.bbox.y && line.y1 <= zone.bbox.y + zone.bbox.height &&
             line.x1 < zone.bbox.x + zone.bbox.width && line.x2 > zone.bbox.x);
        
        if (isInside) {
          const pos = direction === 'V' ? line.x1 : line.y1;
          gaps.push({ start: pos - 1, width: 2 });
        }
      }
    });

    return gaps;
  }

  /**
   * Phân loại các block dựa trên heuristics
   */
  private mergeDropcaps(zones: HLAZone[]) {
    zones.forEach(zone => {
      const dropcaps: HLABlock[] = [];
      const others: HLABlock[] = [];

      zone.blocks.forEach(block => {
        const text = block.text.trim();
        // Kiểm tra xem text có phải là 1-2 ký tự in hoa và font size lớn không
        const isUppercase = text.length > 0 && text === text.toUpperCase() && /[A-ZĂÂĐÊÔƠƯÀẢÃÁẠẰẲẴẮẶẦẨẪẤẬÈẺẼÉẸỀỂỄẾỆÌỈĨÍỊÒỎÕÓỌỒỔỖỐỘỜỞỠỚỢÙỦŨÚỤỪỬỮỨỰỲỶỸÝỴ]/.test(text);
        if (text.length <= 2 && isUppercase && block.fontSize > this.baseFontSize * 1.5) {
          dropcaps.push(block);
        } else {
          others.push(block);
        }
      });

      dropcaps.forEach(dropcap => {
        let bestTarget: HLABlock | null = null;
        let minDistance = Infinity;

        for (const target of others) {
          // Target phải nằm bên phải dropcap (hoặc trùng một chút)
          const isToRight = target.bbox.x >= dropcap.bbox.x - 5;
          // Khoảng cách theo trục X
          const distanceX = target.bbox.x - (dropcap.bbox.x + dropcap.bbox.width);
          // Target phải nằm ngang hàng với dropcap (y của target nằm trong khoảng y của dropcap)
          const isAlongside = target.bbox.y >= dropcap.bbox.y - 10 && target.bbox.y <= dropcap.bbox.y + dropcap.bbox.height + 10;
          
          if (isToRight && distanceX < 40 && isAlongside) {
            const dist = Math.max(0, distanceX) + Math.abs(target.bbox.y - dropcap.bbox.y);
            if (dist < minDistance) {
              minDistance = dist;
              bestTarget = target;
            }
          }
        }

        if (bestTarget) {
          bestTarget.text = dropcap.text.trim() + bestTarget.text;
          // Cập nhật lại bbox của bestTarget để bao trọn dropcap
          const newX = Math.min(bestTarget.bbox.x, dropcap.bbox.x);
          const newY = Math.min(bestTarget.bbox.y, dropcap.bbox.y);
          const newMaxX = Math.max(bestTarget.bbox.x + bestTarget.bbox.width, dropcap.bbox.x + dropcap.bbox.width);
          const newMaxY = Math.max(bestTarget.bbox.y + bestTarget.bbox.height, dropcap.bbox.y + dropcap.bbox.height);
          
          bestTarget.bbox = {
            x: newX,
            y: newY,
            width: newMaxX - newX,
            height: newMaxY - newY
          };
        } else {
          // Nếu không tìm thấy chỗ nối, trả lại dropcap vào danh sách
          others.push(dropcap);
        }
      });

      zone.blocks = others;
    });
  }

  /**
   * Phân loại các block dựa trên heuristics
   */
  private classifyBlocks(zones: HLAZone[], images: VectorImage[]) {
    const cueRegex = /\((xem trang|tiếp theo trang|tiếp từ trang|xem tiếp trang).*\)/i;

    zones.forEach(zone => {
      // Phân loại các block trước
      zone.blocks.forEach(block => {
        // 1. Nhận diện thụt lề (Indentation): Khớp với mô hình 4pt
        if (block.bbox.x > zone.bbox.x + 4 && block.fontSize <= this.baseFontSize + 1) {
          block.isIndented = true;
        }

        // 2. Nhận diện PageCue
        if (cueRegex.test(block.text)) {
          block.label = 'PageCue';
        } 
        // 3. Phân loại theo font size: Title/Sapo > Base + 4pt
        else if (block.fontSize > this.baseFontSize + 4) {
          block.label = 'Headline';
        } else if (block.fontSize > this.baseFontSize + 1) {
          // Chỉ gán nhãn Sapo nếu nó nằm gần một Headline trong cùng zone
          const nearHeadline = zone.blocks.some(b => b.label === 'Headline' && Math.abs(b.bbox.y - block.bbox.y) < 100);
          if (nearHeadline) {
            block.label = 'Sapo';
          } else {
            block.label = 'Content';
          }
        } else if (block.fontSize < this.baseFontSize - 1) {
          block.label = 'Caption';
        } else {
          block.label = 'Content';
        }
      });

      // Phân loại zone dựa trên các block đã gán nhãn
      const hasContent = zone.blocks.some(b => b.label === 'Content' || b.label === 'Headline' || b.label === 'Sapo' || b.label === 'PageCue');
      const hasImage = images.some(img => 
        img.x >= zone.bbox.x - 5 && img.y >= zone.bbox.y - 5 &&
        img.x + img.width <= zone.bbox.x + zone.bbox.width + 5 &&
        img.y + img.height <= zone.bbox.y + zone.bbox.height + 5
      );
      
      zone.type = hasContent ? 'article' : (hasImage ? 'advertisement' : 'unknown');
    });
  }

  /**
   * Tính toán khoảng cách giữa các zone
   */
  private calculateDistance(z1: HLAZone, z2: HLAZone): number {
    const dx = Math.max(0, z2.bbox.x - (z1.bbox.x + z1.bbox.width), z1.bbox.x - (z2.bbox.x + z2.bbox.width));
    const dy = Math.max(0, z2.bbox.y - (z1.bbox.y + z1.bbox.height), z1.bbox.y - (z2.bbox.y + z2.bbox.height));
    return Math.sqrt(dx * dx + dy * dy);
  }
}

export const parseNewspaperLayoutHybrid = async (page: any): Promise<{ zones: HLAZone[], pageWidth: number, pageHeight: number, images: any[] }> => {
  try {
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    // 1. Extract Vector Data
    const vectorData = await extractVectorData(page);

    // 2. Extract Text Content
    const textContent = await page.getTextContent();
    const textItems = textContent.items.map((item: any) => {
      const fontSize = Math.sqrt(item.transform[0] * item.transform[0] + item.transform[1] * item.transform[1]);
      return {
        text: item.str,
        x: item.transform[4],
        y: pageHeight - item.transform[5] - fontSize,
        width: item.width,
        height: fontSize,
        fontSize,
        fontName: item.fontName,
        isBold: item.fontName.toLowerCase().includes('bold') || item.fontName.toLowerCase().includes('heavy')
      };
    });

    // 3. HLA Analysis
    const hlaService = new HLAService();
    const zones = await hlaService.analyze(textItems, vectorData, pageWidth, pageHeight);

    return { zones, pageWidth, pageHeight, images: vectorData.images };
  } catch (error) {
    console.error("Hybrid Layout analysis failed:", error);
    throw error;
  }
};
