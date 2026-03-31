export interface VectorLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  color: string;
  type: 'H' | 'V' | 'D';
}

export interface VectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  thickness: number;
  color: string;
  isFilled?: boolean;
}

export interface VectorImage {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VectorData {
  lines: VectorLine[];
  rects: VectorRect[];
  images: VectorImage[];
}

let pdfjsModule: any = null;

export const extractVectorData = async (page: any): Promise<VectorData> => {
  const lines: VectorLine[] = [];
  const rects: VectorRect[] = [];
  const images: VectorImage[] = [];

  try {
    const operatorList = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;

    if (!pdfjsModule) {
      pdfjsModule = await import('pdfjs-dist/build/pdf.min.mjs');
    }
    const pdfjs = (pdfjsModule as any).default || pdfjsModule;
    
    if (!pdfjs || typeof pdfjs !== 'object') {
      throw new Error('Failed to load pdfjs-dist');
    }
    
    const { OPS } = pdfjs;

    let currentX = 0;
    let currentY = 0;
    let currentLineWidth = 1.0;
    let currentStrokeColor = '#000000'; // Default color
    let currentFillColor = '#000000'; // Default fill color
    let currentCTM = [1, 0, 0, 1, 0, 0];
    const ctmStack: number[][] = [];
    let currentPath: { x: number, y: number }[][] = [];

    const transform = (x: number, y: number) => {
      const [a, b, c, d, e, f] = currentCTM;
      return {
        x: a * x + c * y + e,
        y: pageHeight - (b * x + d * y + f) // Flip Y
      };
    };

    // Helper to convert RGB to Hex
    const rgbToHex = (r: number, g: number, b: number) => {
      return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
    };

    for (let i = 0; i < operatorList.fnArray.length; i++) {
      const fn = operatorList.fnArray[i];
      const args = operatorList.argsArray[i];

      switch (fn) {
        case OPS.save:
          ctmStack.push([...currentCTM]);
          break;

        case OPS.restore:
          if (ctmStack.length > 0) {
            currentCTM = ctmStack.pop()!;
          }
          break;

        case OPS.transform:
          const [a, b, c, d, e, f] = args;
          const [a1, b1, c1, d1, e1, f1] = currentCTM;
          // Matrix multiplication: New CTM = M * Old CTM
          currentCTM = [
            a * a1 + b * c1,
            a * b1 + b * d1,
            c * a1 + d * c1,
            c * b1 + d * d1,
            e * a1 + f * c1 + e1,
            e * b1 + f * d1 + f1
          ];
          break;

        case OPS.setLineWidth:
          currentLineWidth = args[0];
          break;

        case OPS.setStrokeRGBColor:
          currentStrokeColor = rgbToHex(args[0], args[1], args[2]);
          break;

        case OPS.setFillRGBColor:
          currentFillColor = rgbToHex(args[0], args[1], args[2]);
          break;

        case OPS.setFillGray:
          currentFillColor = rgbToHex(args[0], args[0], args[0]);
          break;

        case OPS.moveTo:
          currentX = args[0];
          currentY = args[1];
          currentPath.push([{ x: currentX, y: currentY }]);
          break;

        case OPS.lineTo:
          const lx = args[0];
          const ly = args[1];
          const p1 = transform(currentX, currentY);
          const p2 = transform(lx, ly);

          const type = Math.abs(p1.x - p2.x) < 1 ? 'V' : (Math.abs(p1.y - p2.y) < 1 ? 'H' : 'D');
          lines.push({
            x1: p1.x,
            y1: p1.y,
            x2: p2.x,
            y2: p2.y,
            thickness: currentLineWidth,
            color: currentStrokeColor,
            type
          });

          currentX = lx;
          currentY = ly;
          if (currentPath.length === 0) {
            currentPath.push([{ x: currentX, y: currentY }]);
          } else {
            currentPath[currentPath.length - 1].push({ x: currentX, y: currentY });
          }
          break;

        case OPS.rectangle:
          const rx = args[0];
          const ry = args[1];
          const rw = args[2];
          const rh = args[3];
          const rp1 = transform(rx, ry);
          const rp2 = transform(rx + rw, ry + rh);
          rects.push({
            x: Math.min(rp1.x, rp2.x),
            y: Math.min(rp1.y, rp2.y),
            width: Math.abs(rp1.x - rp2.x),
            height: Math.abs(rp1.y - rp2.y),
            thickness: currentLineWidth,
            color: currentStrokeColor
          });
          currentPath.push([
            { x: rx, y: ry },
            { x: rx + rw, y: ry },
            { x: rx + rw, y: ry + rh },
            { x: rx, y: ry + rh }
          ]);
          break;

        case OPS.constructPath:
          // Handle complex path construction which often contains rectangles
          const pathOps = args[0];
          const pathArgs = args[1];
          if (!pathOps || typeof pathOps.length !== 'number') break;
          
          let argIdx = 0;
          let pathStart = { x: currentX, y: currentY };
          
          for (let j = 0; j < pathOps.length; j++) {
            const op = pathOps[j];
            if (op === OPS.moveTo) {
              currentX = pathArgs[argIdx++];
              currentY = pathArgs[argIdx++];
              pathStart = { x: currentX, y: currentY };
              currentPath.push([pathStart]);
            } else if (op === OPS.lineTo) {
              const x = pathArgs[argIdx++];
              const y = pathArgs[argIdx++];
              const p1 = transform(currentX, currentY);
              const p2 = transform(x, y);
              lines.push({
                x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
                thickness: currentLineWidth, color: currentStrokeColor,
                type: Math.abs(p1.x - p2.x) < 1 ? 'V' : (Math.abs(p1.y - p2.y) < 1 ? 'H' : 'D')
              });
              currentX = x;
              currentY = y;
              if (currentPath.length === 0) {
                currentPath.push([{ x: currentX, y: currentY }]);
              } else {
                currentPath[currentPath.length - 1].push({ x: currentX, y: currentY });
              }
            } else if (op === OPS.rectangle) {
              const x = pathArgs[argIdx++];
              const y = pathArgs[argIdx++];
              const w = pathArgs[argIdx++];
              const h = pathArgs[argIdx++];
              const p1 = transform(x, y);
              const p2 = transform(x + w, y + h);
              rects.push({
                x: Math.min(p1.x, p2.x),
                y: Math.min(p1.y, p2.y),
                width: Math.abs(p1.x - p2.x),
                height: Math.abs(p1.y - p2.y),
                thickness: currentLineWidth,
                color: currentStrokeColor
              });
              currentPath.push([
                { x, y },
                { x: x + w, y },
                { x: x + w, y: y + h },
                { x, y: y + h }
              ]);
            } else if (op === OPS.closePath) {
              if (currentPath.length > 0) {
                const lastSubpath = currentPath[currentPath.length - 1];
                if (lastSubpath.length >= 3) {
                  const minX = Math.min(...lastSubpath.map(p => p.x));
                  const maxX = Math.max(...lastSubpath.map(p => p.x));
                  const minY = Math.min(...lastSubpath.map(p => p.y));
                  const maxY = Math.max(...lastSubpath.map(p => p.y));
                  const tp1 = transform(minX, minY);
                  const tp2 = transform(maxX, maxY);
                  rects.push({
                    x: Math.min(tp1.x, tp2.x), y: Math.min(tp1.y, tp2.y),
                    width: Math.abs(tp1.x - tp2.x), height: Math.abs(tp1.y - tp2.y),
                    thickness: currentLineWidth, color: currentStrokeColor
                  });
                }
              }
            }
          }
          break;

        case OPS.fill:
        case OPS.eoFill:
        case OPS.fillStroke:
        case OPS.eoFillStroke:
          for (const subpath of currentPath) {
            if (subpath.length >= 3) {
              const minX = Math.min(...subpath.map(p => p.x));
              const maxX = Math.max(...subpath.map(p => p.x));
              const minY = Math.min(...subpath.map(p => p.y));
              const maxY = Math.max(...subpath.map(p => p.y));
              const tp1 = transform(minX, minY);
              const tp2 = transform(maxX, maxY);
              rects.push({
                x: Math.min(tp1.x, tp2.x),
                y: Math.min(tp1.y, tp2.y),
                width: Math.abs(tp1.x - tp2.x),
                height: Math.abs(tp1.y - tp2.y),
                thickness: 0,
                color: currentFillColor,
                isFilled: true
              });
            }
          }
          break;

        case OPS.paintImageXObject:
        case OPS.paintInlineImageXObject:
          const imgP1 = transform(0, 0);
          const imgP2 = transform(1, 1);
          images.push({
            x: Math.min(imgP1.x, imgP2.x),
            y: Math.min(imgP1.y, imgP2.y),
            width: Math.abs(imgP1.x - imgP2.x),
            height: Math.abs(imgP1.y - imgP2.y)
          });
          break;
      }
    }
  } catch (error) {
    console.error("Vector extraction failed:", error);
  }

  return { lines, rects, images };
};
