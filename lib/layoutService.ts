import { extractVectorData } from './vectorService';
import { BoundingBox, ArticleRegion } from './types';
import { segmentRegions } from './segmentationService';
import { HLAService, HLAZone } from './hlaService';

const hlaService = new HLAService();

function groupTextItems(items: any[], thresholdX = 15, thresholdY = 5) {
  if (items.length === 0) return [];
  
  // Sort items primarily by Y (top-down), then by X
  const sorted = [...items].sort((a, b) => (Math.abs(a.y - b.y) < thresholdY ? a.x - b.x : a.y - b.y));
  
  const lines: any[] = [];
  let currentLine: any[] = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    
    // Ngưỡng khoảng cách ngang để coi là cùng một khối văn bản (khoảng 2 lần font size)
    const horizontalGapThreshold = Math.max(prev.fontSize, curr.fontSize) * 2.0;
    
    const sameLine = Math.abs(curr.y - prev.y) < thresholdY;
    const closeX = curr.x - (prev.x + prev.width) < horizontalGapThreshold;
    
    if (sameLine && closeX) {
      currentLine.push(curr);
    } else {
      lines.push(currentLine);
      currentLine = [curr];
    }
  }
  lines.push(currentLine);
  
  return lines.map(line => {
    const x = Math.min(...line.map((i: any) => i.x));
    const y = Math.min(...line.map((i: any) => i.y));
    const maxX = Math.max(...line.map((i: any) => i.x + i.width));
    const maxY = Math.max(...line.map((i: any) => i.y + i.height));
    const text = line.map((i: any) => i.text).join(' ');
    const fontSize = Math.max(...line.map((i: any) => i.fontSize));
    return {
      x, y, width: maxX - x, height: maxY - y, text, fontSize,
      fontName: line[0].fontName,
      isBold: line[0].isBold
    };
  });
}

// Spatial Index for faster proximity checks
class SpatialIndex {
  private grid: Map<string, any[]> = new Map();
  private cellSize: number;

  constructor(cellSize = 50) {
    this.cellSize = cellSize;
  }

  private getKey(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  add(item: any) {
    const x1 = Math.floor(item.x / this.cellSize);
    const x2 = Math.floor((item.x + item.width) / this.cellSize);
    const y1 = Math.floor(item.y / this.cellSize);
    const y2 = Math.floor((item.y + item.height) / this.cellSize);

    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        const key = `${x},${y}`;
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key)!.push(item);
      }
    }
  }

  query(x: number, y: number, width: number, height: number): any[] {
    const x1 = Math.floor(x / this.cellSize);
    const x2 = Math.floor((x + width) / this.cellSize);
    const y1 = Math.floor(y / this.cellSize);
    const y2 = Math.floor((y + height) / this.cellSize);

    const results = new Set<any>();
    for (let gx = x1; gx <= x2; gx++) {
      for (let gy = y1; gy <= y2; gy++) {
        const key = `${gx},${gy}`;
        const items = this.grid.get(key);
        if (items) {
          for (const item of items) {
            // Check for actual overlap
            if (
              item.x < x + width &&
              item.x + item.width > x &&
              item.y < y + height &&
              item.y + item.height > y
            ) {
              results.add(item);
            }
          }
        }
      }
    }
    return Array.from(results);
  }
}

function mergeBoxes(boxes: BoundingBox[], threshold = 5, pageWidth?: number): BoundingBox[] {
  const groups: Record<string, BoundingBox[]> = {};
  for (const box of boxes) {
    if (!groups[box.label]) groups[box.label] = [];
    groups[box.label].push(box);
  }

  const mergedBoxes: BoundingBox[] = [];

  for (const label in groups) {
    // Sort by Y to allow early exit in inner loop
    let group = groups[label].sort((a, b) => a.y - b.y || a.x - b.x);
    
    let i = 0;
    while (i < group.length) {
      let boxA = group[i];
      let merged = false;
      
      // Since it's sorted by Y, we only need to check boxes that could possibly overlap or be close
      for (let j = i + 1; j < group.length; j++) {
        let boxB = group[j];
        
        // Early exit: if boxB is too far below boxA, no more boxes in sorted group can merge
        if (boxB.y > boxA.y + boxA.height + 40) break; 

        // Check if boxes are close
        const overlapX = Math.max(boxA.x, boxB.x) < Math.min(boxA.x + boxA.width, boxB.x + boxB.width) + threshold;
        const overlapY = Math.max(boxA.y, boxB.y) < Math.min(boxA.y + boxA.height, boxB.y + boxB.height) + threshold;
        
        // Special case for vertical merging of content in columns
        const isVerticalContent = (boxA.label === 'Content' || boxA.label === 'Sapo' || boxA.label === 'Headline' || boxA.label === 'Footer Note') &&
                                 Math.abs(boxA.x - boxB.x) < 20 && // Similar X
                                 (boxA.label === 'Headline' || Math.abs(boxA.width - boxB.width) < 40) && // Similar width (relaxed for Headline)
                                 (boxB.y - (boxA.y + boxA.height) < 30); // Close vertically
          
        // Do not merge lines
        const isLine = boxA.label === 'Horizontal Line' || boxA.label === 'Vertical Line';

        if (!isLine && ((overlapX && overlapY) || isVerticalContent)) {
          const x = Math.min(boxA.x, boxB.x);
          const y = Math.min(boxA.y, boxB.y);
          const maxX = Math.max(boxA.x + boxA.width, boxB.x + boxB.width);
          const maxY = Math.max(boxA.y + boxA.height, boxB.y + boxB.height);
          
          boxA = {
            ...boxA,
            x, y, width: maxX - x, height: maxY - y,
            text: (boxA.text || '') + ' ' + (boxB.text || '')
          };
          group.splice(j, 1);
          j--;
          merged = true;
        }
      }
      mergedBoxes.push(boxA);
      i++;
    }
  }

  // Apply specific rule: Merge Footer Note with Content above if narrow
  if (pageWidth) {
    const columnWidthThreshold = pageWidth * 0.35;
    const finalMerged: BoundingBox[] = [];
    const footerNotes = mergedBoxes.filter(b => b.label === 'Footer Note' && b.width <= columnWidthThreshold);
    const others = mergedBoxes.filter(b => !footerNotes.includes(b));
    
    const mergedFooterIds = new Set<string>();

    others.forEach(box => {
      if (box.label === 'Content') {
        const footerAbove = footerNotes.find(f => 
          !mergedFooterIds.has(f.id) &&
          Math.abs(f.x - box.x) < 20 &&
          f.y > box.y &&
          f.y - (box.y + box.height) < 40
        );

        if (footerAbove) {
          box.height = (footerAbove.y + footerAbove.height) - box.y;
          box.text = (box.text || '') + '\n\n' + (footerAbove.text || '');
          mergedFooterIds.add(footerAbove.id);
        }
      }
      finalMerged.push(box);
    });

    // Add remaining footers
    footerNotes.forEach(f => {
      if (!mergedFooterIds.has(f.id)) finalMerged.push(f);
    });

    return finalMerged;
  }

  return mergedBoxes;
}

declare const cv: any;

/**
 * Phân tích layout bằng OpenCV.js
 */
async function processImageWithOpenCV(pageImage: string, pageWidth: number, pageHeight: number, pdfImages: any[] = [], textItems: any[] = []): Promise<{ boxes: BoundingBox[], maskBase64?: string }> {
  if (typeof cv === 'undefined' || !cv.Mat) {
    console.warn("OpenCV.js is not loaded or initialized.");
    return { boxes: [] };
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const src = cv.imread(img);
      const gray = new cv.Mat();
      const binary = new cv.Mat();
      
      // 1. Chuyển sang Grayscale
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      
      // 2. Nhị phân hóa với ngưỡng cứng 240 (giữ nét mảnh)
      // Sử dụng THRESH_BINARY_INV để vật thể (đường kẻ, khung) là mầu trắng (255) trên nền đen (0)
      cv.threshold(gray, binary, 240, 255, cv.THRESH_BINARY_INV);
      
      const detectedBoxes: BoundingBox[] = [];
      const mask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC4);
      
      // Create Spatial Index for text items to optimize proximity checks
      const textIndex = new SpatialIndex(100);
      textItems.forEach(item => textIndex.add(item));
      
      // 3. Tìm đường kẻ ngang (H-Lines) bằng Morphology
      // Tăng kích thước kernel để chỉ bắt các đường dài (1/10 chiều rộng)
      const hKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.round(src.cols / 10), 1));
      const hLines = new cv.Mat();
      cv.erode(binary, hLines, hKernel);
      cv.dilate(hLines, hLines, hKernel);

      // 4. Tìm đường kẻ dọc (V-Lines) bằng Morphology
      // Tăng kích thước kernel để chỉ bắt các đường dài (1/10 chiều cao)
      const vKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.round(src.rows / 10)));
      const vLines = new cv.Mat();
      cv.erode(binary, vLines, vKernel);
      cv.dilate(vLines, vLines, vKernel);

      // --- Header Detection Logic ---
      let headerBottomCV = 0;
      // Giảm vùng nhận diện header từ 15% xuống 8% chiều cao trang
      const topZoneHeightCV = src.rows * 0.08;
      
      // 1. Find long horizontal lines in the top zone
      const contoursForHeader = new cv.MatVector();
      const hierarchyForHeader = new cv.Mat();
      cv.findContours(hLines, contoursForHeader, hierarchyForHeader, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      
      let maxHeaderLineY = 0;
      for (let i = 0; i < contoursForHeader.size(); ++i) {
        const rect = cv.boundingRect(contoursForHeader.get(i));
        // Yêu cầu đường kẻ phải nằm rất sát mép trên (dưới 8% trang)
        // và phải rất dài (ít nhất 80% chiều rộng trang)
        if (rect.y < topZoneHeightCV && rect.width > src.cols * 0.8) {
          if (rect.y + rect.height > maxHeaderLineY) {
            maxHeaderLineY = rect.y + rect.height;
          }
        }
      }
      contoursForHeader.delete(); hierarchyForHeader.delete();
      
      headerBottomCV = maxHeaderLineY;
      // --- End Header Detection ---

      // --- Footer Detection Logic ---
      let footerTopCV = src.rows;
      const bottomZoneStartCV = src.rows * 0.85; // 15% bottom zone
      
      const contoursForFooter = new cv.MatVector();
      const hierarchyForFooter = new cv.Mat();
      cv.findContours(hLines, contoursForFooter, hierarchyForFooter, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      
      let minFooterLineY = src.rows;
      for (let i = 0; i < contoursForFooter.size(); ++i) {
        const rect = cv.boundingRect(contoursForFooter.get(i));
        if (rect.y > bottomZoneStartCV && rect.width > src.cols * 0.5) {
          if (rect.y < minFooterLineY) {
            minFooterLineY = rect.y;
          }
        }
      }
      contoursForFooter.delete(); hierarchyForFooter.delete();
      
      footerTopCV = minFooterLineY;
      // --- End Footer Detection ---
      
      const thresholdX = src.cols * 0.1;
      const thresholdY = src.rows * 0.1;
      const proximity = Math.min(src.cols, src.rows) * 0.02;
      const extX = src.cols * 0.03;
      const extY = src.rows * 0.03;

      const getDist = (px: number, py: number, r: any) => {
        const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
        const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
        return Math.sqrt(dx * dx + dy * dy);
      };

      const hRects: any[] = [];
      const vRects: any[] = [];
      
      const fillRects = (mat: any, list: any[], isHorizontal: boolean) => {
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(mat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < contours.size(); ++i) {
          const cnt = contours.get(i);
          const rect = cv.boundingRect(cnt);
          
          // Lọc nghiêm ngặt: 
          // 1. Phải đủ dài (ít nhất 15% kích thước trang)
          // 2. Phải mỏng (không quá 10px) để tránh bắt nhầm cạnh của khối hoặc ảnh
          const minLength = isHorizontal ? src.cols * 0.15 : src.rows * 0.15;
          const maxThickness = 10; 
          
          if (isHorizontal) {
            if (rect.width >= minLength && rect.height <= maxThickness) {
              list.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            }
          } else {
            if (rect.height >= minLength && rect.width <= maxThickness) {
              list.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            }
          }
        }
        contours.delete(); hierarchy.delete();
      };

      fillRects(hLines, hRects, true);
      fillRects(vLines, vRects, false);
      const allRects = [...hRects, ...vRects];

      // Trích xuất tọa độ đường kẻ từ mask morphology
      const processLines = (rects: any[], label: 'Horizontal Line' | 'Vertical Line', color: number[]) => {
        const scaleToCVX = src.cols / pageWidth;
        const scaleToCVY = src.rows / pageHeight;
        const cvImages = pdfImages.map(img => ({
          x: img.x * scaleToCVX,
          y: img.y * scaleToCVY,
          width: img.width * scaleToCVX,
          height: img.height * scaleToCVY
        }));

        rects.forEach((rect, i) => {
          // 0. Kiểm tra xem có trùng hoặc đè vào trong ảnh không
          const tolerance = 2;
          const isInsideImage = cvImages.some(img => {
            const overlapsX = rect.x < img.x + img.width - tolerance && rect.x + rect.width > img.x + tolerance;
            const overlapsY = rect.y < img.y + img.height - tolerance && rect.y + rect.height > img.y + tolerance;
            return overlapsX && overlapsY;
          });

          if (isInsideImage) return;

          // Kiểm tra xem đường kẻ có nằm trong một khối đặc (filled box) không
          const isInsideFilledBox = allRects.some(other => {
            if (other === rect) return false;
            // Kiểm tra xem 'other' có phải là khối đặc không (extent > 0.8)
            // Cần tính lại extent cho 'other' hoặc lưu lại thông tin này
            // Tạm thời kiểm tra dựa trên kích thước và vị trí bao
            return other.width > rect.width * 2 && other.height > rect.height * 2 &&
                   rect.x >= other.x && rect.x + rect.width <= other.x + other.width &&
                   rect.y >= other.y && rect.y + rect.height <= other.y + other.height;
          });
          
          if (isInsideFilledBox) return;

          // Kiểm tra xem đường kẻ có nằm sát cạnh một hình ảnh và có chiều dài tương đương không
          const isImageBorder = cvImages.some(img => {
            const isNearEdge = (
              // Sát cạnh trái hoặc phải (tăng tolerance lên 15)
              (Math.abs(rect.x - img.x) < 15 || Math.abs(rect.x + rect.width - (img.x + img.width)) < 15) &&
              // Chiều dài tương đương chiều cao ảnh (tăng tolerance lên 20)
              Math.abs(rect.height - img.height) < 20
            ) || (
              // Sát cạnh trên hoặc dưới (tăng tolerance lên 15)
              (Math.abs(rect.y - img.y) < 15 || Math.abs(rect.y + rect.height - (img.y + img.height)) < 15) &&
              // Chiều dài tương đương chiều rộng ảnh (tăng tolerance lên 20)
              Math.abs(rect.width - img.width) < 20
            );
            return isNearEdge;
          });

          if (isImageBorder) return;

          // 1. Kéo dài 3% nếu gần đường khác
          if (label === 'Horizontal Line') {
            const leftNear = allRects.some(o => o.x !== rect.x && o.y !== rect.y && getDist(rect.x, rect.y + rect.height/2, o) < proximity);
            const rightNear = allRects.some(o => o.x !== rect.x && o.y !== rect.y && getDist(rect.x + rect.width, rect.y + rect.height/2, o) < proximity);
            if (leftNear) { rect.x -= extX; rect.width += extX; }
            if (rightNear) { rect.width += extX; }
          } else {
            const topNear = allRects.some(o => o.x !== rect.x && o.y !== rect.y && getDist(rect.x + rect.width/2, rect.y, o) < proximity);
            const bottomNear = allRects.some(o => o.x !== rect.x && o.y !== rect.y && getDist(rect.x + rect.width/2, rect.y + rect.height, o) < proximity);
            if (topNear) { rect.y -= extY; rect.height += extY; }
            if (bottomNear) { rect.height += extY; }
          }

          // 2. Kéo dài ra sát lề nếu gần lề (10%)
          if (label === 'Horizontal Line') {
            if (rect.x < thresholdX) {
              rect.width += rect.x;
              rect.x = 0;
            }
            if (rect.x + rect.width > src.cols - thresholdX) {
              rect.width = src.cols - rect.x;
            }
          } else {
            if (rect.y < thresholdY) {
              rect.height += rect.y;
              rect.y = 0;
            }
            if (rect.y + rect.height > src.rows - thresholdY) {
              rect.height = src.rows - rect.y;
            }
          }

          // Đảm bảo trong biên
          rect.x = Math.max(0, rect.x);
          rect.y = Math.max(0, rect.y);
          rect.width = Math.min(src.cols - rect.x, rect.width);
          rect.height = Math.min(src.rows - rect.y, rect.height);

          const scaleX = pageWidth / src.cols;
          const scaleY = pageHeight / src.rows;
          
          detectedBoxes.push({
            id: `cv-line-${label}-${i}`,
            x: rect.x * scaleX,
            y: rect.y * scaleY,
            width: rect.width * scaleX,
            height: rect.height * scaleY,
            label,
            confidence: 0.9,
            color: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.8)`
          });
          
          // Vẽ lên mask (mở rộng 3px)
          const padding = 3;
          cv.rectangle(mask, 
                       new cv.Point(Math.max(0, rect.x - padding), Math.max(0, rect.y - padding)), 
                       new cv.Point(Math.min(src.cols, rect.x + rect.width + padding), Math.min(src.rows, rect.y + rect.height + padding)), 
                       new cv.Scalar(color[0], color[1], color[2], 200), -1);
        });
      };
      
      processLines(hRects, 'Horizontal Line', [0, 120, 255]); // Blue for H
      processLines(vRects, 'Vertical Line', [0, 200, 0]);    // Green for V
      
      // 5. Tìm Contours để phát hiện khung rỗng (Hollow Frames) và khối đặc (Filled Boxes)
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(binary, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
      
      const minWidthCV = src.cols * 0.1;
      const minHeightCV = src.rows * 0.1;

      for (let i = 0; i < contours.size(); ++i) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        const area = cv.contourArea(cnt);
        const rectArea = rect.width * rect.height;
        const extent = area / rectArea;
        
        // Chỉ xác định các box có độ rộng và chiều cao vượt quá 10% trang
        if (rect.width < minWidthCV || rect.height < minHeightCV) continue;

        const scaleX = pageWidth / src.cols;
        const scaleY = pageHeight / src.rows;

        // Kiểm tra xem box này có chứa ảnh không (không chỉ là nằm trong ảnh)
        const scaleToCVX = src.cols / pageWidth;
        const scaleToCVY = src.rows / pageHeight;
        const cvImages = pdfImages.map(img => ({
          x: img.x * scaleToCVX,
          y: img.y * scaleToCVY,
          width: img.width * scaleToCVX,
          height: img.height * scaleToCVY
        }));
        const tolerance = 2;
        
        // Box chứa ảnh nếu ảnh nằm trong box
        const containsImage = cvImages.some(img => {
          return img.x >= rect.x - tolerance && 
                 img.x + img.width <= rect.x + rect.width + tolerance &&
                 img.y >= rect.y - tolerance && 
                 img.y + img.height <= rect.y + rect.height + tolerance;
        });

        if (containsImage) continue;

        // Kiểm tra xem có chứa cả text và ảnh không
        const wordsInside = textIndex.query(rect.x * scaleX - 5, rect.y * scaleY - 5, rect.width * scaleX + 10, rect.height * scaleY + 10);
        const hasText = wordsInside.length > 0;
        
        const hasImage = cvImages.some(img => {
          return img.x >= rect.x - tolerance && 
                 img.x + img.width <= rect.x + rect.width + tolerance &&
                 img.y >= rect.y - tolerance && 
                 img.y + img.height <= rect.y + rect.height + tolerance;
        });

        const isMixedContent = hasText && hasImage;

        // Kéo dài ra sát lề nếu gần lề (10%)
        if (rect.x < thresholdX) {
          rect.width += rect.x;
          rect.x = 0;
        }
        if (rect.x + rect.width > src.cols - thresholdX) {
          rect.width = src.cols - rect.x;
        }
        if (rect.y < thresholdY) {
          rect.height += rect.y;
          rect.y = 0;
        }
        if (rect.y + rect.height > src.rows - thresholdY) {
          rect.height = src.rows - rect.y;
        }
        
        // Kiểm tra xem có phải khối đặc (Filled Box) không
        if (extent > 0.8) {
          if (hasText || hasImage) {
            detectedBoxes.push({
              id: `cv-filled-${i}`,
              x: rect.x * scaleX,
              y: rect.y * scaleY,
              width: rect.width * scaleX,
              height: rect.height * scaleY,
              label: 'Filled Box',
              confidence: 0.8,
              color: 'rgba(128, 0, 128, 0.5)' // Purple for mixed filled box
            });
            
            // Phủ nền trên Mask
            cv.rectangle(mask, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), 
                         new cv.Scalar(128, 0, 128, 150), -1);
            // Vẽ đường viền bao trên Mask
            cv.rectangle(mask, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), 
                         new cv.Scalar(128, 0, 128, 255), 2);
          }
        } else {
          // Khung rỗng (Hollow Frame)
          // Dựa vào hierarchy để biết là khung (có con bên trong)
          const h = hierarchy.data32S[i * 4 + 2]; // First child
          if (h !== -1) {
            // Phân loại dựa trên độ dày (ước lượng qua extent hoặc perimeter)
            const perimeter = cv.arcLength(cnt, true);
            const thickness = (rectArea - area) / perimeter;
            
            const label = thickness > 2.0 ? 'Text Box' : 'Image Box';
            
            detectedBoxes.push({
              id: `cv-frame-${i}`,
              x: rect.x * scaleX,
              y: rect.y * scaleY,
              width: rect.width * scaleX,
              height: rect.height * scaleY,
              label,
              confidence: 0.85
            });
            
            cv.rectangle(mask, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), 
                         new cv.Scalar(255, 0, 0, 150), 2);
          }
        }
      }
      
      // Vẽ đường kẻ phân định Header lên trên cùng (chạy đè lên các phần tử khác)
      if (headerBottomCV > 0) {
        cv.line(mask, 
          new cv.Point(-100, headerBottomCV), 
          new cv.Point(src.cols + 100, headerBottomCV), 
          new cv.Scalar(255, 0, 0, 255), 3 // Red color for high visibility, 3px thickness
        );
      }

      // Vẽ đường kẻ phân định Footer lên trên cùng
      if (footerTopCV < src.rows) {
        cv.line(mask, 
          new cv.Point(-100, footerTopCV), 
          new cv.Point(src.cols + 100, footerTopCV), 
          new cv.Scalar(255, 0, 0, 255), 3 // Red color, 3px thickness
        );
      }

      // Tạo ảnh mask base64
      const canvas = document.createElement('canvas');
      cv.imshow(canvas, mask);
      const maskBase64 = canvas.toDataURL();
      
      // Cleanup
      src.delete(); gray.delete(); binary.delete(); hKernel.delete(); vKernel.delete(); 
      hLines.delete(); vLines.delete(); contours.delete(); hierarchy.delete(); mask.delete();
      
      resolve({ boxes: detectedBoxes, maskBase64 });
    };
    img.src = pageImage;
  });
}

export const parseNewspaperLayout = async (page: any, pageImage?: string): Promise<{ boxes: BoundingBox[], vectorData: any, maskImage?: string, cells: ArticleRegion[] }> => {
  try {
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    // 1. Extract Vector Data
    const { lines, rects, images } = await extractVectorData(page);
    const vectorData = { lines, rects, pageWidth, pageHeight };

    // 2. Extract Text Content with Attributes (Moved up)
    const textContent = await page.getTextContent();
    const rawTextItems = textContent.items.map((item: any) => {
      const fontSize = Math.sqrt(item.transform[0] * item.transform[0] + item.transform[1] * item.transform[1]);
      return {
        text: item.str,
        x: item.transform[4],
        y: pageHeight - item.transform[5] - fontSize, // Flip Y coordinate
        width: item.width,
        height: fontSize,
        fontSize,
        fontName: item.fontName,
        isBold: item.fontName.toLowerCase().includes('bold') || item.fontName.toLowerCase().includes('heavy')
      };
    });

    // Group raw items into lines/blocks
    const textItems = groupTextItems(rawTextItems);

    // 3. OpenCV Analysis (if image provided)
    let cvResult: { boxes: BoundingBox[], maskBase64?: string } = { boxes: [] };
    if (pageImage) {
      cvResult = await processImageWithOpenCV(pageImage, pageWidth, pageHeight, images, textItems);
    }

    // Create Spatial Index for text items to optimize proximity checks
    const textIndex = new SpatialIndex(100);
    textItems.forEach(item => textIndex.add(item));

    // 3. Filter Lines (Underlines and Text Intersections)
    const filteredLines = lines.filter(line => {
      const nearbyText = textIndex.query(
        Math.min(line.x1, line.x2) - 5,
        Math.min(line.y1, line.y2) - 5,
        Math.abs(line.x2 - line.x1) + 10,
        Math.abs(line.y2 - line.y1) + 10
      );

      const isUnderline = nearbyText.some((item: any) => 
        line.type === 'H' &&
        Math.abs(line.y1 - (item.y + item.height)) < 3 &&
        line.x1 >= item.x - 5 &&
        line.x2 <= item.x + item.width + 5
      );
      if (isUnderline) return false;

      const intersectsText = nearbyText.some((item: any) => 
        line.x1 < item.x + item.width &&
        line.x2 > item.x &&
        line.y1 < item.y + item.height &&
        line.y2 > item.y
      );
      if (intersectsText) return false;

      return true;
    });

    let detectedBoxes: BoundingBox[] = [];

    // 5. Classify Rectangles (Text Box vs Image Box)
    const minWidth = pageWidth * 0.1;
    const minHeight = pageHeight * 0.1;

    rects.forEach((rect, index) => {
      if (!rect.isFilled && (rect.width < minWidth || rect.height < minHeight)) return;
      if (rect.isFilled && (rect.width < 10 || rect.height < 10)) return;
      if (rect.isFilled && rect.color === '#ffffff') return;

      const wordsInside = textIndex.query(rect.x - 5, rect.y - 5, rect.width + 10, rect.height + 10);

      const imagesInside = images.filter((img: any) => 
        img.x >= rect.x - 10 &&
        img.x + img.width <= rect.x + rect.width + 10 &&
        img.y >= rect.y - 10 &&
        img.y + img.height <= rect.y + rect.height + 10
      );

      const hasText = wordsInside.length > 0;
      const hasImage = imagesInside.length > 0;
      const combinedText = wordsInside.map((w: any) => w.text).join(' ');

      let label: BoundingBox['label'] = 'Text Region';
      
      if (rect.isFilled) {
        label = 'Filled Box';
      } else if (rect.thickness >= 1.5) {
        // Thick border = Box
        label = hasImage ? 'Image Box' : 'Text Box';
      } else {
        // Thin/No border = Region
        label = hasImage ? 'Image Region' : 'Text Region';
      }

      detectedBoxes.push({
        id: `rect-${index}`,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        label,
        confidence: 1.0,
        text: combinedText,
        color: rect.color
      });
    });

    // 6. Classify Text Elements (Headline, Sapo, Caption, Author, ToContinue, ContinuePage)
    const boxIndex = new SpatialIndex(100);
    detectedBoxes.forEach(box => boxIndex.add(box));

    const looseTextItems = textItems.filter((item: any) => {
      const nearbyBoxes = boxIndex.query(item.x - 2, item.y - 2, item.width + 4, item.height + 4);
      return !nearbyBoxes.some((box: any) => 
        item.x >= box.x - 2 && 
        item.x + item.width <= box.x + box.width + 2 &&
        item.y >= box.y - 2 &&
        item.y + item.height <= box.y + box.height + 2
      );
    });

    looseTextItems.forEach((item: any, index: number) => {
      if (item.text.trim().length < 2) return;

      const fontName = item.fontName || '';
      const fontSize = item.fontSize || 0;
      const text = item.text.trim();

      let label: BoundingBox['label'] = 'Content';

      // 0. Header/Footer Detection based on position and patterns
      const isTopZone = item.y < pageHeight * 0.15;
      const isBottomZone = item.y > pageHeight * 0.85;
      
      const headerPatterns = [
        /năm thứ/i, /số:/i, /www\./i, /\.vn/i, /\.com/i,
        /thứ (hai|ba|tư|năm|sáu|bảy|bảy|chủ nhật)/i,
        /ngày \d+/i, /tháng \d+/i, /năm \d{4}/i,
        /trang \d+/i, /chuyên mục/i
      ];
      const footerPatterns = [
        /trang \d+/i, /xem tiếp/i, /tiếp theo/i, /xem trang/i,
        /tòa soạn/i, /nhà in/i, /liên hệ/i, /giấy phép/i, /tổng biên tập/i
      ];
      
      const matchesHeader = headerPatterns.some(p => p.test(text));
      const matchesFooter = footerPatterns.some(p => p.test(text));
      
      if (isTopZone && (matchesHeader || (text.toUpperCase() === text && text.length < 20))) {
        label = 'Header';
      } else if (isBottomZone && (matchesFooter || (text.toUpperCase() === text && text.length < 20))) {
        label = 'Footer';
      }
      // 1. Tiêu đề: UTM-Aurora (hoặc chứa Aurora), size >= 30
      else if ((fontName.includes('Aurora') || fontName.includes('UTM-Aurora')) && fontSize >= 30) {
        label = 'Headline';
      }
      // 2. Tác giả: Theky-ND-Century|sc725BTBolCon-Bold, size <= 10
      else if ((fontName.includes('Theky-ND-Century') || fontName.includes('sc725BTBolCon-Bold')) && fontSize <= 10) {
        label = 'Author';
      }
      // 3. Sapo: Hadong-ND-CondensedBlack, size < 12
      else if (fontName.includes('Hadong-ND-CondensedBlack') && fontSize < 12) {
        label = 'Sapo';
      }
      // 4. Chú thích ảnh: Theky-ND-Century|sc725BTBolCon-Bold, size <= 10
      else if ((fontName.includes('Theky-ND-Century') || fontName.includes('sc725BTBolCon-Bold')) && fontSize <= 10) {
        label = 'Caption';
      }
      // 5. Xem trang: Hanam-ND-Regular, size <= 10
      else if (fontName.includes('Hanam-ND-Regular') && fontSize <= 10 && /xem trang/i.test(text)) {
        label = 'ContinuePage'; // Mapping "Xem trang" to ContinuePage
      }
      // 6. Tiếp theo trang: Hanoi-ND-Italic, size <= 10
      else if (fontName.includes('Hanoi-ND-Italic') && fontSize <= 10 && /tiếp theo trang/i.test(text)) {
        label = 'ToContinue'; // Mapping "Tiếp theo trang" to ToContinue
      }
      // 7. ToContinue: Hanam-ND-Regular, size <= 10
      else if (fontName.includes('Hanam-ND-Regular') && fontSize <= 10) {
        label = 'ToContinue';
      }
      // 8. Nội dung: 
      // - Hanoi-ND-Regular (size <= 10)
      // - UTM-Aurora (size <= 16)
      // - Hanoi-ND-Italic (size <= 10)
      else if (
        (fontName.includes('Hanoi-ND-Regular') && fontSize <= 10) ||
        (fontName.includes('UTM-Aurora') && fontSize <= 16) ||
        (fontName.includes('Hanoi-ND-Italic') && fontSize <= 10)
      ) {
        label = 'Content';
      }
      // Fallback heuristics
      else {
        if (fontSize >= 20) label = 'Headline';
        else if (fontSize > 11) label = 'Sapo';
        else label = 'Content';
      }

      detectedBoxes.push({
        id: `text-${index}`,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        label,
        confidence: 1.0,
        text: item.text,
        fontSize: item.fontSize,
        fontName: item.fontName,
        isBold: item.isBold
      });
    });

    // 7. Add Horizontal and Vertical Lines for visualization
    filteredLines.forEach((line, index) => {
      const label = line.type === 'H' ? 'Horizontal Line' : (line.type === 'V' ? 'Vertical Line' : null);
      if (!label) return;

      detectedBoxes.push({
        id: `line-${index}`,
        x: Math.min(line.x1, line.x2),
        y: Math.min(line.y1, line.y2),
        width: Math.max(1, Math.abs(line.x2 - line.x1)),
        height: Math.max(1, Math.abs(line.y2 - line.y1)),
        label,
        confidence: 1.0,
        text: label,
        color: line.color
      });
    });

    // 8. Merge adjacent boxes of the same type and apply semantic rules
    detectedBoxes = mergeBoxes([...detectedBoxes, ...cvResult.boxes], 5, pageWidth);

    // 9. Segment Regions
    const regions = segmentRegions(detectedBoxes, pageHeight);
    const cells: ArticleRegion[] = regions.map(r => ({
      id: r.id,
      polygon: [
        { x: r.bounds.x, y: r.bounds.y },
        { x: r.bounds.x + r.bounds.width, y: r.bounds.y },
        { x: r.bounds.x + r.bounds.width, y: r.bounds.y + r.bounds.height },
        { x: r.bounds.x, y: r.bounds.y + r.bounds.height }
      ],
      bbox: r.bounds
    }));

    return { boxes: detectedBoxes, vectorData, maskImage: cvResult.maskBase64, cells };
  } catch (error) {
    console.error("Layout analysis failed:", error);
    return { boxes: [], vectorData: null, cells: [] };
  }
};
