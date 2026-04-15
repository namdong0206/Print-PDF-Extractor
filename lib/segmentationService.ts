import { BoundingBox, ArticleRegion } from './types';
import { TextBlock, Article } from './geminiProcessor';

export interface Region {
  id: string;
  boxes: string[]; // IDs of BoundingBoxes
  label: string;
  bounds: { x: number, y: number, width: number, height: number };
}

// Hàm kiểm tra xem một điểm có nằm trong đa giác không (Ray Casting Algorithm)
function isPointInPolygon(point: { x: number, y: number }, polygon: { x: number, y: number }[]) {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) isInside = !isInside;
  }
  return isInside;
}

// Hàm kiểm tra xem một box có nằm trong Article Region không
function isBoxInArticleRegion(box: BoundingBox, region: ArticleRegion) {
  // Kiểm tra 4 góc của box
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }
  ];
  
  // Nếu có ít nhất 1 góc nằm trong đa giác, coi như thuộc về region đó
  // Hoặc nếu tâm của box nằm trong đa giác
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  
  return corners.some(corner => isPointInPolygon(corner, region.polygon)) || isPointInPolygon(center, region.polygon);
}

export const groupBoxesByArticleRegion = (boxes: BoundingBox[], regions: ArticleRegion[]): Map<string, BoundingBox[]> => {
  const grouped = new Map<string, BoundingBox[]>();
  
  regions.forEach(region => {
    const regionBoxes = boxes.filter(box => isBoxInArticleRegion(box, region));
    // Sắp xếp các box trong region theo thứ tự đọc (Headline -> Author -> Sapo -> Content)
    const sortedBoxes = regionBoxes.sort((a, b) => {
      const order = ['Headline', 'Author', 'Sapo', 'Content', 'Caption', 'Text Box', 'Image Box', 'Text Region', 'Image Region'];
      const idxA = order.indexOf(a.label);
      const idxB = order.indexOf(b.label);
      
      if (idxA !== idxB) {
        return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
      }
      
      // Nếu cùng loại (ví dụ: nhiều block Content), sắp xếp theo thứ tự đọc báo:
      // Sử dụng heuristic: Nếu hai box đè lên nhau theo phương ngang (overlap X), 
      // chúng thuộc cùng một "cột" hoặc một dải dọc -> sắp xếp theo Y (trên xuống dưới).
      // Nếu không đè lên nhau, chúng thuộc các cột khác nhau -> sắp xếp theo X (trái sang phải).
      const aRight = a.x + a.width;
      const bRight = b.x + b.width;
      const overlapX = Math.max(a.x, b.x) < Math.min(aRight, bRight) - 5; // Trừ 5px để tránh nhiễu do sai số nhỏ
      
      if (overlapX) {
        return a.y - b.y;
      }
      
      return a.x - b.x;
    });
    
    grouped.set(region.id, sortedBoxes);
  });
  
  return grouped;
};

export const segmentRegions = (boxes: BoundingBox[]): Region[] => {
  if (boxes.length === 0) return [];

  // Separate content boxes and line boxes
  const contentBoxes = boxes.filter(b => !['Horizontal Line', 'Vertical Line'].includes(b.label));
  const lineBoxes = boxes.filter(b => ['Horizontal Line', 'Vertical Line'].includes(b.label));

  // 1. Build a graph where boxes are nodes and edges exist if boxes overlap or are close,
  //    AND no structural barrier (line) exists between them.
  const adj = new Map<string, string[]>();
  for (let i = 0; i < contentBoxes.length; i++) {
    for (let j = i + 1; j < contentBoxes.length; j++) {
      const boxA = contentBoxes[i];
      const boxB = contentBoxes[j];
      
      // Check if close or overlapping
      const xThreshold = 20; // Reduced from 40 to be more precise
      const yThreshold = 10; // Reduced from 20 to be more precise
      
      const overlapX = Math.max(boxA.x, boxB.x) < Math.min(boxA.x + boxA.width, boxB.x + boxB.width) + xThreshold;
      const overlapY = Math.max(boxA.y, boxB.y) < Math.min(boxA.y + boxA.height, boxB.y + boxB.height) + yThreshold;
      
      if (overlapX && overlapY) {
        // Check for barriers
        const isBlocked = lineBoxes.some(line => {
          if (line.label === 'Vertical Line') {
            // Check if line is strictly between boxA and boxB horizontally
            const isBetweenX = (boxA.x + boxA.width <= line.x && line.x <= boxB.x) || 
                               (boxB.x + boxB.width <= line.x && line.x <= boxA.x);
            // Check if line spans the vertical overlap of the two boxes
            const overlapYRange = [Math.max(boxA.y, boxB.y), Math.min(boxA.y + boxA.height, boxB.y + boxB.height)];
            const lineSpansY = line.y < overlapYRange[1] + 20 && line.y + line.height > overlapYRange[0] - 20;
            
            return isBetweenX && lineSpansY;
          } else if (line.label === 'Horizontal Line') {
            // Check if line is strictly between boxA and boxB vertically
            const isBetweenY = (boxA.y + boxA.height <= line.y && line.y <= boxB.y) || 
                               (boxB.y + boxB.height <= line.y && line.y <= boxA.y);
            // Check if line spans the horizontal overlap of the two boxes
            const overlapXRange = [Math.max(boxA.x, boxB.x), Math.min(boxA.x + boxA.width, boxB.x + boxB.width)];
            const lineSpansX = line.x < overlapXRange[1] + 20 && line.x + line.width > overlapXRange[0] - 20;
            
            return isBetweenY && lineSpansX;
          }
          return false;
        });

        if (!isBlocked) {
          adj.set(boxA.id, [...(adj.get(boxA.id) || []), boxB.id]);
          adj.set(boxB.id, [...(adj.get(boxB.id) || []), boxA.id]);
        }
      }
    }
  }

  // 2. BFS to find connected components (regions)
  const regions: Region[] = [];
  const visited = new Set<string>();
  
  for (const box of contentBoxes) {
    if (visited.has(box.id)) continue;
    
    const component: string[] = [];
    const queue = [box.id];
    visited.add(box.id);
    
    while (queue.length > 0) {
      const currId = queue.shift()!;
      component.push(currId);
      
      const neighbors = adj.get(currId) || [];
      for (const nId of neighbors) {
        if (!visited.has(nId)) {
          visited.add(nId);
          queue.push(nId);
        }
      }
    }
    
    // 3. Calculate bounds for the region
    const componentBoxes = contentBoxes.filter(b => component.includes(b.id));
    const minX = Math.min(...componentBoxes.map(b => b.x));
    const maxX = Math.max(...componentBoxes.map(b => b.x + b.width));
    const minY = Math.min(...componentBoxes.map(b => b.y));
    const maxY = Math.max(...componentBoxes.map(b => b.y + b.height));
    
    regions.push({
      id: `region-${regions.length + 1}`,
      boxes: component,
      label: `Article ${regions.length + 1}`,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    });
  }
  
  return regions;
};

export const groupTextBlocksIntoArticles = (textBlocks: TextBlock[], regions: ArticleRegion[], pageNumber: number): Article[] => {
  // 1. Convert TextBlocks to BoundingBoxes
  const boxes: BoundingBox[] = textBlocks.map(tb => ({
    id: tb.id.toString(),
    x: tb.x,
    y: tb.y,
    width: tb.t.length * (tb.fs * 0.5), // Heuristic width
    height: tb.fs,
    label: 'Content',
    confidence: 1.0,
    text: tb.t
  }));

  // 2. Group boxes by region
  const grouped = groupBoxesByArticleRegion(boxes, regions);

  // 3. Convert groups to Articles
  const articles: Article[] = [];
  grouped.forEach((groupedBoxes, regionId) => {
    // Sắp xếp theo thứ tự đọc chuẩn: Từ trái sang phải (X), sau đó từ trên xuống dưới (Y)
    // Đối với các cột, thứ tự này sẽ đảm bảo đọc hết cột trái rồi sang cột phải.
    const sortedBoxes = groupedBoxes.sort((a, b) => {
      // Nếu các box nằm cùng một dải ngang (overlap Y), ưu tiên X
      const overlapY = Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height);
      if (overlapY) {
        return a.x - b.x;
      }
      // Nếu không, ưu tiên Y (trên xuống dưới)
      return a.y - b.y;
    });
    
    const article: Article = {
      id: `article_${regionId}`,
      articleRegionId: regionId,
      title: sortedBoxes[0]?.text || "Không có tiêu đề",
      author: "",
      content: sortedBoxes.map(b => b.text || ""),
      imageCaption: "",
      seePage: "",
      pageNumbers: [pageNumber]
    };
    articles.push(article);
  });

  return articles;
};
