import RBush from 'rbush';
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

interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  data: any;
}

/**
 * Hybrid Layout Analysis Service
 */
export class HLAService {
  private baseFontSize: number = 10;
  private blockTree: RBush<SpatialItem> = new RBush();
  private imageTree: RBush<SpatialItem> = new RBush();

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

    // 3. Phân tích bố cục bằng thuật toán Đồ thị (Graph Theory) kết hợp R-Tree
    let zones = this.graphClustering(blocks, vectorData, pageWidth, pageHeight);

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
    if (blocks.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
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
      let prevLineStartX = current.items && current.items.length > 0 ? current.items[0].x : current.bbox.x;

      for (let i = 1; i < zone.blocks.length; i++) {
        const next = zone.blocks[i];

        // Điều kiện gom: Cùng nhãn, khoảng cách dọc gần nhau VÀ phải có sự chồng lấn ngang đáng kể
        const sameLabel = current.label === next.label;
        
        // Headline thường có thể gom rộng hơn (tăng lên 40pt để bắt các tiêu đề lớn nhiều dòng)
        const isHeadline = current.label === 'Headline';
        const verticalThreshold = isHeadline ? 40 : 15;

        const overlapX = Math.max(0, Math.min(current.bbox.x + current.bbox.width, next.bbox.x + next.bbox.width) - Math.max(current.bbox.x, next.bbox.x));
        const minWidth = Math.min(current.bbox.width, next.bbox.width);
        const hasHorizontalOverlap = overlapX > minWidth * 0.6; // Phải chồng lấn ít nhất 60% chiều rộng

        const gapY = next.bbox.y - (current.bbox.y + current.bbox.height);

        // Không gộp nếu block tiếp theo là Headline (bắt đầu bài báo mới)
        if (next.label === 'Headline') {
          merged.push(current);
          current = { ...next };
          prevLineStartX = next.items && next.items.length > 0 ? next.items[0].x : next.bbox.x;
          continue;
        }

        if (sameLabel && hasHorizontalOverlap && Math.abs(gapY) < verticalThreshold) {
          // Nhận diện thụt đầu dòng (Indentation)
          // So sánh lề trái của dòng mới với lề trái của cột (zone.bbox.x)
          const nextStartX = next.items && next.items.length > 0 ? next.items[0].x : next.bbox.x;
          
          // Thụt lề được định nghĩa là cách lề trái của cột một khoảng đáng kể (0.8 - 1.5 * fontSize)
          // HOẶC đầu dòng có 2+ ký tự trắng (space) liên tiếp
          const zoneLeftMargin = zone.blocks.reduce((min, b) => Math.min(min, b.bbox.x), Infinity);
          const isIndentedBySpace = /^\s{2,}/.test(next.text);
          const isIndentedByMargin = nextStartX > zoneLeftMargin + (this.baseFontSize * 0.8);
          const isIndented = isIndentedBySpace || isIndentedByMargin;

          if (isIndented) {
            current.text += "\n" + next.text.trimStart();
          } else {
            current.text += " " + next.text;
          }
          
          prevLineStartX = nextStartX; // Cập nhật lại X của dòng trước đó
          
          const newMaxX = Math.max(current.bbox.x + current.bbox.width, next.bbox.x + next.bbox.width);
          const newMaxY = Math.max(current.bbox.y + current.bbox.height, next.bbox.y + next.bbox.height);
          current.bbox.x = Math.min(current.bbox.x, next.bbox.x);
          current.bbox.y = Math.min(current.bbox.y, next.bbox.y);
          current.bbox.width = newMaxX - current.bbox.x;
          current.bbox.height = newMaxY - current.bbox.y;
        } else {
          merged.push(current);
          current = { ...next };
          prevLineStartX = current.items && current.items.length > 0 ? current.items[0].x : current.bbox.x;
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
    // 1. Loại bỏ các item trùng lặp
    const uniqueItems: any[] = [];
    const seen = new Set<string>();
    
    items.forEach(item => {
      const rx = Math.round(item.x);
      const ry = Math.round(item.y);
      const key = `${item.text}_${rx}_${ry}`;
      
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

    // 2. Sắp xếp theo Y (trên xuống), sau đó X (trái sang) - Tối ưu theo yêu cầu
    const sorted = [...uniqueItems].sort((a, b) => 
      Math.abs(a.y - b.y) < 3 ? a.x - b.x : a.y - b.y
    );

    const lines: any[][] = [];
    if (sorted.length === 0) return [];

    let currentLine = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      
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

    const blocks = lines.map((line, idx) => {
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
        isIndented: false,
        label: 'unknown',
        items: line
      };
    });

    // Xây dựng R-Tree cho các block
    this.blockTree.clear();
    this.blockTree.load(blocks.map(b => ({
      minX: b.bbox.x,
      minY: b.bbox.y,
      maxX: b.bbox.x + b.bbox.width,
      maxY: b.bbox.y + b.bbox.height,
      id: b.id,
      data: b
    })));

    return blocks;
  }

  /**
   * Sắp xếp các block theo thứ tự đọc thông minh (Column-aware sorting)
   */
  private sortBlocksByReadingOrder(blocks: HLABlock[]): HLABlock[] {
    if (blocks.length <= 1) return blocks;

    const headerMetaBlocks: HLABlock[] = [];
    const bodyBlocks: HLABlock[] = [];

    blocks.forEach(block => {
      if (['Headline', 'Sapo', 'Caption', 'PageCue'].includes(block.label)) {
        headerMetaBlocks.push(block);
      } else {
        bodyBlocks.push(block);
      }
    });

    headerMetaBlocks.sort((a, b) => a.bbox.y - b.bbox.y);

    const columns: HLABlock[][] = [];
    const sortedByY = [...bodyBlocks].sort((a, b) => a.bbox.y - b.bbox.y);
    
    // Tìm chiều rộng cột trung bình để nhận diện block rộng
    const blockWidths = bodyBlocks.map(b => b.bbox.width).sort((a, b) => a - b);
    const medianWidth = blockWidths[Math.floor(blockWidths.length / 2)] || 100;
    const wideThreshold = medianWidth * 1.5;

    const sortedBody: HLABlock[] = [];
    let currentGroup: HLABlock[] = [];

    sortedByY.forEach(block => {
      if (block.bbox.width > wideThreshold) {
        // Nếu gặp block rộng, xử lý nhóm hiện tại trước
        if (currentGroup.length > 0) {
          sortedBody.push(...this.sortGroupIntoColumns(currentGroup));
          currentGroup = [];
        }
        sortedBody.push(block);
      } else {
        currentGroup.push(block);
      }
    });

    if (currentGroup.length > 0) {
      sortedBody.push(...this.sortGroupIntoColumns(currentGroup));
    }

    return [...headerMetaBlocks, ...sortedBody];
  }

  /**
   * Hỗ trợ sortBlocksByReadingOrder: Chia một nhóm block thành các cột và sắp xếp
   */
  private sortGroupIntoColumns(blocks: HLABlock[]): HLABlock[] {
    if (blocks.length <= 1) return blocks;
    
    const columns: HLABlock[][] = [];
    const sortedByX = [...blocks].sort((a, b) => a.bbox.x - b.bbox.x);

    sortedByX.forEach(block => {
      let placed = false;
      for (const col of columns) {
        const colX1 = Math.min(...col.map(b => b.bbox.x));
        const colX2 = Math.max(...col.map(b => b.bbox.x + b.bbox.width));
        
        const overlapX = Math.max(0, Math.min(block.bbox.x + block.bbox.width, colX2) - Math.max(block.bbox.x, colX1));
        const minWidth = Math.min(block.bbox.width, colX2 - colX1);
        
        if (overlapX > minWidth * 0.5) { // Tăng ngưỡng chồng lấn lên 50% cho cột
          col.push(block);
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push([block]);
      }
    });

    columns.sort((a, b) => {
      const aX = Math.min(...a.map(b => b.bbox.x));
      const bX = Math.min(...b.map(b => b.bbox.x));
      return aX - bX;
    });

    const result: HLABlock[] = [];
    columns.forEach(col => {
      col.sort((a, b) => a.bbox.y - b.bbox.y);
      result.push(...col);
    });
    return result;
  }

  /**
   * Phân tích bố cục bằng thuật toán Đồ thị (Graph Theory) kết hợp R-Tree
   */
  private graphClustering(
    blocks: HLABlock[],
    vectorData: VectorData,
    width: number,
    height: number
  ): HLAZone[] {
    if (blocks.length === 0) return [];

    // Xây dựng R-Tree cho hình ảnh
    this.imageTree.clear();
    this.imageTree.load(vectorData.images.map((img, idx) => ({
      minX: img.x,
      minY: img.y,
      maxX: img.x + img.width,
      maxY: img.y + img.height,
      id: `img-${idx}`,
      data: img
    })));

    // Tạo các block giả cho hình ảnh để đưa vào đồ thị
    const imageBlocks: HLABlock[] = vectorData.images.map((img, idx) => ({
      id: `img-block-${idx}`,
      text: '[IMAGE]',
      bbox: { x: img.x, y: img.y, width: img.width, height: img.height },
      fontSize: 10, // dummy
      fontName: 'Image',
      isBold: false,
      isIndented: false,
      label: 'Image',
      items: []
    }));

    const allNodes = [...blocks, ...imageBlocks];

    // Cập nhật blockTree với allNodes
    this.blockTree.clear();
    this.blockTree.load(allNodes.map(b => ({
      minX: b.bbox.x,
      minY: b.bbox.y,
      maxX: b.bbox.x + b.bbox.width,
      maxY: b.bbox.y + b.bbox.height,
      id: b.id,
      data: b
    })));

    // Ước tính chiều rộng cột (Column Width) dựa trên các block văn bản
    const blockWidths = blocks.map(b => b.bbox.width).sort((a, b) => a - b);
    const medianBlockWidth = blockWidths[Math.floor(blockWidths.length / 2)] || 100;
    const minSeparatorLength = medianBlockWidth * 0.8; // Ngưỡng: 80% chiều rộng cột

    // Xây dựng R-Tree cho các đường kẻ và khung viền để kiểm tra vật cản
    const vectorTree = new RBush<SpatialItem>();
    
    // Chỉ lấy các đường kẻ có độ dài đủ lớn (vượt quá 1 cột nội dung đối với đường ngang)
    const longLines = vectorData.lines.filter(l => {
      const length = l.type === 'V' ? Math.abs(l.y2 - l.y1) : Math.abs(l.x2 - l.x1);
      
      if (l.type === 'V') {
        // Đường kẻ dọc: Chỉ cần dài hơn 2 dòng văn bản (khoảng 30pt) là có thể coi là phân cách cột
        return length > 30;
      } else {
        // Đường kẻ ngang: Phải dài hơn 80% chiều rộng cột để tránh nhầm với gạch chân tiêu đề
        return length > minSeparatorLength;
      }
    });

    vectorTree.load(longLines.map((l, idx) => ({
      minX: Math.min(l.x1, l.x2),
      minY: Math.min(l.y1, l.y2),
      maxX: Math.max(l.x1, l.x2),
      maxY: Math.max(l.y1, l.y2),
      id: `line-${idx}`,
      data: l
    })));
    vectorTree.load(vectorData.rects.map((r, idx) => ({
      minX: r.x,
      minY: r.y,
      maxX: r.x + r.width,
      maxY: r.y + r.height,
      id: `rect-${idx}`,
      data: r
    })));

    // Khởi tạo đồ thị: danh sách kề
    const adj: Map<string, string[]> = new Map();
    allNodes.forEach(b => adj.set(b.id, []));

    // Duyệt qua từng block để tìm hàng xóm và vẽ cạnh
    allNodes.forEach(block => {
      const thresholdX = 30; // Ngưỡng khoảng cách ngang
      const thresholdY = block.label === 'Image' ? 40 : block.fontSize * 2.5; // Ngưỡng khoảng cách dọc linh hoạt

      const searchArea = {
        minX: block.bbox.x - thresholdX,
        minY: block.bbox.y - thresholdY,
        maxX: block.bbox.x + block.bbox.width + thresholdX,
        maxY: block.bbox.y + block.bbox.height + thresholdY
      };

      const neighbors = this.blockTree.search(searchArea);

      neighbors.forEach(node => {
        const neighbor = node.data as HLABlock;
        if (neighbor.id === block.id) return;

        // 1. Kiểm tra khoảng cách hình học
        const distY = Math.max(0, neighbor.bbox.y - (block.bbox.y + block.bbox.height), block.bbox.y - (neighbor.bbox.y + neighbor.bbox.height));
        const distX = Math.max(0, neighbor.bbox.x - (block.bbox.x + block.bbox.width), block.bbox.x - (neighbor.bbox.x + neighbor.bbox.width));

        if (distY > thresholdY || distX > thresholdX) return;

        // 2. Kiểm tra vật cản (Separator Check)
        const p1 = { x: block.bbox.x + block.bbox.width / 2, y: block.bbox.y + block.bbox.height / 2 };
        const p2 = { x: neighbor.bbox.x + neighbor.bbox.width / 2, y: neighbor.bbox.y + neighbor.bbox.height / 2 };

        const lineBBox = {
          minX: Math.min(p1.x, p2.x) - 5, // Tăng padding để bắt các đường kẻ mảnh
          minY: Math.min(p1.y, p2.y) - 5,
          maxX: Math.max(p1.x, p2.x) + 5,
          maxY: Math.max(p1.y, p2.y) + 5
        };

        const potentialSeparators = vectorTree.search(lineBBox);
        let isBlocked = false;

        for (const sepNode of potentialSeparators) {
          const sep = sepNode.data;
          if ('x1' in sep) { // Line
            if (this.lineIntersectsLine(p1.x, p1.y, p2.x, p2.y, sep.x1, sep.y1, sep.x2, sep.y2)) {
              isBlocked = true;
              break;
            }
          } else { // Rect
            // Kiểm tra xem đoạn thẳng nối 2 tâm có cắt bất kỳ cạnh nào của rect không
            const r = sep as VectorRect;
            const rectLines = [
              { x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y }, // top
              { x1: r.x, y1: r.y + r.height, x2: r.x + r.width, y2: r.y + r.height }, // bottom
              { x1: r.x, y1: r.y, x2: r.x, y2: r.y + r.height }, // left
              { x1: r.x + r.width, y1: r.y, x2: r.x + r.width, y2: r.y + r.height } // right
            ];
            for (const rl of rectLines) {
              if (this.lineIntersectsLine(p1.x, p1.y, p2.x, p2.y, rl.x1, rl.y1, rl.x2, rl.y2)) {
                isBlocked = true;
                break;
              }
            }
            if (isBlocked) break;
          }
        }

        if (!isBlocked) {
          adj.get(block.id)?.push(neighbor.id);
        }
      });
    });

    // Tìm các thành phần liên thông (Connected Components) bằng BFS
    const visited = new Set<string>();
    const components: HLABlock[][] = [];

    allNodes.forEach(block => {
      if (!visited.has(block.id)) {
        const component: HLABlock[] = [];
        const queue = [block.id];
        visited.add(block.id);

        while (queue.length > 0) {
          const currId = queue.shift()!;
          const currBlock = allNodes.find(b => b.id === currId)!;
          component.push(currBlock);

          adj.get(currId)?.forEach(neighborId => {
            if (!visited.has(neighborId)) {
              const neighbor = allNodes.find(b => b.id === neighborId)!;
              
              // Logic kiểm tra: Không gộp nếu gặp Headline mới
              // Nếu block hiện tại là Headline hoặc Image, và neighbor cũng là Headline, 
              // thì không nên gộp chúng vào cùng một bài báo.
              if ((currBlock.label === 'Headline' || currBlock.label === 'Image') && neighbor.label === 'Headline') {
                return;
              }

              visited.add(neighborId);
              queue.push(neighborId);
            }
          });
        }
        components.push(component);
      }
    });

    // Chuyển đổi các thành phần liên thông thành HLAZone
    return components.map((comp, idx) => ({
      id: `zone-${idx}`,
      bbox: this.calculateBBox(comp),
      blocks: comp,
      type: 'unknown'
    }));
  }

  /**
   * Kiểm tra giao cắt giữa 2 đoạn thẳng (Line Intersection) sử dụng CCW
   */
  private lineIntersectsLine(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
    const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
      return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
    };
    // Kiểm tra xem p3 và p4 có nằm về hai phía của đoạn p1-p2 không, và ngược lại
    return ccw(x1, y1, x3, y3, x4, y4) !== ccw(x2, y2, x3, y3, x4, y4) &&
           ccw(x1, y1, x2, y2, x3, y3) !== ccw(x1, y1, x2, y2, x4, y4);
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
    // Xây dựng R-Tree cho hình ảnh
    this.imageTree.clear();
    this.imageTree.load(vectorData.images.map((img, idx) => ({
      minX: img.x,
      minY: img.y,
      maxX: img.x + img.width,
      maxY: img.y + img.height,
      id: `img-${idx}`,
      data: img
    })));

    const root: HLAZone = {
      id: 'root',
      bbox: { x: 0, y: 0, width, height },
      blocks,
      type: 'unknown'
    };

    const split = (zone: HLAZone, depth: number): HLAZone[] => {
      if (depth > 15 || zone.blocks.length <= 1) return [zone];

      const vGaps = this.findGaps(zone, 'V', vectorData);
      if (vGaps.length > 0) {
        const sortedGaps = vGaps.sort((a, b) => b.width - a.width);
        const bestGap = sortedGaps[0];
        
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

      const hGaps = this.findGaps(zone, 'H', vectorData);
      if (hGaps.length > 0) {
        const bestGap = hGaps.sort((a, b) => b.width - a.width)[0];
        
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

  private findGaps(zone: HLAZone, direction: 'H' | 'V', vectorData: VectorData) {
    const gaps: { start: number, width: number }[] = [];
    const size = direction === 'V' ? zone.bbox.width : zone.bbox.height;
    const offset = direction === 'V' ? zone.bbox.x : zone.bbox.y;
    
    const occupied = new Array(Math.ceil(size)).fill(false);
    
    zone.blocks.forEach(b => {
      const start = Math.floor((direction === 'V' ? b.bbox.x : b.bbox.y) - offset);
      const end = Math.ceil((direction === 'V' ? b.bbox.x + b.bbox.width : b.bbox.y + b.bbox.height) - offset);
      for (let i = Math.max(0, start); i < Math.min(size, end); i++) occupied[i] = true;
    });

    // Sử dụng R-Tree để tìm ảnh giao với zone hiện tại
    const searchArea = {
      minX: zone.bbox.x,
      minY: zone.bbox.y,
      maxX: zone.bbox.x + zone.bbox.width,
      maxY: zone.bbox.y + zone.bbox.height
    };
    const intersectingImages = this.imageTree.search(searchArea);

    intersectingImages.forEach(imgNode => {
      const img = imgNode.data;
      const start = Math.floor((direction === 'V' ? img.x : img.y) - offset);
      const end = Math.ceil((direction === 'V' ? img.x + img.width : img.y + img.height) - offset);
      for (let i = Math.max(0, start); i < Math.min(size, end); i++) occupied[i] = true;
    });

    let gapStart = -1;
    for (let i = 0; i < occupied.length; i++) {
      if (!occupied[i]) {
        if (gapStart === -1) gapStart = i;
      } else {
        if (gapStart !== -1) {
          const gapWidth = i - gapStart;
          const threshold = direction === 'V' ? 5 : 3;
          if (gapWidth > threshold) { 
            gaps.push({ start: gapStart + offset, width: gapWidth });
          }
          gapStart = -1;
        }
      }
    }
    if (gapStart !== -1 && occupied.length - gapStart > (direction === 'V' ? 5 : 3)) {
      gaps.push({ start: gapStart + offset, width: occupied.length - gapStart });
    }

    // Ưu tiên các đường kẻ (lines)
    vectorData.lines.forEach(line => {
      if (line.type === direction) {
        const isInside = direction === 'V' 
          ? (line.x1 >= zone.bbox.x && line.x1 <= zone.bbox.x + zone.bbox.width && 
             line.y1 < zone.bbox.y + zone.bbox.height && line.y2 > zone.bbox.y)
          : (line.y1 >= zone.bbox.y && line.y1 <= zone.bbox.y + zone.bbox.height &&
             line.x1 < zone.bbox.x + zone.bbox.width && line.x2 > zone.bbox.x);
        
        if (isInside) {
          const pos = direction === 'V' ? line.x1 : line.y1;
          // Tăng trọng số cho đường kẻ bằng cách tạo gap ảo tại vị trí đường kẻ
          gaps.push({ start: pos - 2, width: 4 });
        }
      }
    });

    // Ưu tiên các khung viền/nền (rects) làm phân cách
    vectorData.rects.forEach(rect => {
      const isInside = (rect.x >= zone.bbox.x && rect.x + rect.width <= zone.bbox.x + zone.bbox.width &&
                        rect.y >= zone.bbox.y && rect.y + rect.height <= zone.bbox.y + zone.bbox.height);
      
      if (isInside) {
        if (direction === 'V') {
          // Kẻ dọc: Dùng cạnh trái và phải của rect
          gaps.push({ start: rect.x - 2, width: 4 });
          gaps.push({ start: rect.x + rect.width - 2, width: 4 });
        } else {
          // Kẻ ngang: Dùng cạnh trên và dưới của rect
          gaps.push({ start: rect.y - 2, width: 4 });
          gaps.push({ start: rect.y + rect.height - 2, width: 4 });
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
        const isUppercase = text.length > 0 && text === text.toUpperCase() && /[A-ZĂÂĐÊÔƠƯÀẢÃÁẠẰẲẴẮẶẦẨẪẤẬÈẺẼÉẸỀỂỄẾỆÌỈĨÍỊÒỎÕÓỌỒỔỖỐỘỜỞỠỚỢÙỦŨÚỤỪỬỮỨỰỲỶỸÝỴ]/.test(text);
        const isLargeFont = block.fontSize > this.baseFontSize * 1.5;
        const isLargeHeight = block.bbox.height > this.baseFontSize * 2.0;
        
        if (text.length <= 2 && isUppercase && (isLargeFont || isLargeHeight)) {
          dropcaps.push(block);
        } else {
          others.push(block);
        }
      });

      // Tối ưu tìm kiếm block lân cận bằng R-Tree
      dropcaps.forEach(dropcap => {
        let bestTarget: HLABlock | null = null;
        let minDistance = Infinity;

        // Tìm trong vùng lân cận bên phải dropcap
        const searchArea = {
          minX: dropcap.bbox.x - 20,
          minY: dropcap.bbox.y - 20,
          maxX: dropcap.bbox.x + dropcap.bbox.width + 100,
          maxY: dropcap.bbox.y + dropcap.bbox.height + 20
        };
        
        const candidates = this.blockTree.search(searchArea);

        for (const node of candidates) {
          const target = node.data as HLABlock;
          if (target.id === dropcap.id) continue;
          
          const isToRight = target.bbox.x >= dropcap.bbox.x - 20;
          const distanceX = target.bbox.x - (dropcap.bbox.x + dropcap.bbox.width);
          const isAlongside = target.bbox.y >= dropcap.bbox.y - 20 && target.bbox.y <= dropcap.bbox.y + dropcap.bbox.height + 20;
          const isHeightMatch = dropcap.bbox.height >= target.fontSize * 1.5 && dropcap.bbox.height <= target.fontSize * 8.0;
          
          if (isToRight && distanceX < 60 && isAlongside && isHeightMatch) {
            const dist = Math.max(0, distanceX) + Math.abs(target.bbox.y - dropcap.bbox.y);
            if (dist < minDistance) {
              minDistance = dist;
              bestTarget = target;
            }
          }
        }

        if (bestTarget) {
          bestTarget.text = dropcap.text.trim() + bestTarget.text;
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
      zone.blocks.forEach(block => {
        if (block.label === 'Image') return;

        const text = block.text.trim();
        const isUppercase = text.length > 0 && text === text.toUpperCase() && /[A-ZĂÂĐÊÔƠƯÀẢÃÁẠẰẲẴẮẶẦẨẪẤẬÈẺẼÉẸỀỂỄẾỆÌỈĨÍỊÒỎÕÓỌỒỔỖỐỘỜỞỠỚỢÙỦŨÚỤỪỬỮỨỰỲỶỸÝỴ]/.test(text);
        const isShort = text.length < 60;
        const isNotMuchLarger = block.fontSize <= this.baseFontSize + 8;
        const fitsInColumn = block.bbox.width <= zone.bbox.width + 5;

        if (cueRegex.test(block.text)) {
          block.label = 'PageCue';
        } 
        else if (block.fontSize > this.baseFontSize + 2.5 || (block.isBold && block.fontSize > this.baseFontSize + 0.5)) {
          // Nếu là text viết hoa toàn bộ, ngắn, font không quá lớn và nằm trọn trong chiều rộng zone -> Coi là Content
          if (isUppercase && isShort && isNotMuchLarger && fitsInColumn && !block.isBold) {
            block.label = 'Content';
          } else {
            block.label = 'Headline';
          }
        } else if (block.fontSize > this.baseFontSize + 0.5) {
          // Tương tự cho trường hợp font nhỉnh hơn một chút (thường là Sapo hoặc Sub-headline)
          if (isUppercase && isShort && fitsInColumn) {
            block.label = 'Content';
          } else {
            const nearHeadline = zone.blocks.some(b => b.label === 'Headline' && Math.abs(b.bbox.y - block.bbox.y) < 100);
            if (nearHeadline) {
              block.label = 'Sapo';
            } else {
              block.label = 'Content';
            }
          }
        } else if (block.fontSize < this.baseFontSize - 1) {
          block.label = 'Caption';
        } else {
          block.label = 'Content';
        }
      });

      const hasContent = zone.blocks.some(b => b.label === 'Content' || b.label === 'Headline' || b.label === 'Sapo' || b.label === 'PageCue');
      const hasImage = zone.blocks.some(b => b.label === 'Image');
      
      zone.type = hasContent ? 'article' : (hasImage ? 'advertisement' : 'unknown');
    });
  }
}

export const parseNewspaperLayoutHybrid = async (page: any): Promise<{ zones: HLAZone[], pageWidth: number, pageHeight: number, images: any[] }> => {
  try {
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    const vectorData = await extractVectorData(page);

    const textContent = await page.getTextContent();
    const textItems = textContent.items
      .map((item: any) => {
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
      })
      .filter((item: any) => item.text.trim().length > 0);

    const hlaService = new HLAService();
    const zones = await hlaService.analyze(textItems, vectorData, pageWidth, pageHeight);

    return { zones, pageWidth, pageHeight, images: vectorData.images };
  } catch (error) {
    console.error("Hybrid Layout analysis failed:", error);
    throw error;
  }
};

/**
 * Phân tích layout từ dữ liệu đã trích xuất (Dùng cho Worker)
 */
export const analyzeLayoutData = async (
  textItems: any[],
  vectorData: VectorData,
  pageWidth: number,
  pageHeight: number
): Promise<{ zones: HLAZone[], pageWidth: number, pageHeight: number, images: any[] }> => {
  try {
    const hlaService = new HLAService();
    const zones = await hlaService.analyze(textItems, vectorData, pageWidth, pageHeight);
    return { zones, pageWidth, pageHeight, images: vectorData.images };
  } catch (error) {
    console.error("Layout analysis data failed:", error);
    throw error;
  }
};
