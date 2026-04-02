import { VectorImage } from './vectorService';
import { Article, TextBlock, normalize } from './geminiProcessor';
import { HLAZone } from './hlaService';

export interface ClusteredImage {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clusterImages(images: VectorImage[]): ClusteredImage[] {
  // Filter out very small images (noise, icons)
  const validImages = images.filter(img => img.width > 40 && img.height > 40);
  
  if (validImages.length === 0) return [];

  const clusters: ClusteredImage[] = [];
  
  for (const img of validImages) {
    let matchedCluster = null;
    
    for (const cluster of clusters) {
      // Check if img is adjacent or overlapping with cluster
      // Allow a small gap (e.g., 5px) for sliced images
      const gap = 5;
      const isOverlappingOrAdjacent = !(
        img.x > cluster.x + cluster.width + gap ||
        img.x + img.width < cluster.x - gap ||
        img.y > cluster.y + cluster.height + gap ||
        img.y + img.height < cluster.y - gap
      );
      
      if (isOverlappingOrAdjacent) {
        matchedCluster = cluster;
        break;
      }
    }
    
    if (matchedCluster) {
      // Merge img into matchedCluster
      const newX = Math.min(matchedCluster.x, img.x);
      const newY = Math.min(matchedCluster.y, img.y);
      const newMaxX = Math.max(matchedCluster.x + matchedCluster.width, img.x + img.width);
      const newMaxY = Math.max(matchedCluster.y + matchedCluster.height, img.y + img.height);
      
      matchedCluster.x = newX;
      matchedCluster.y = newY;
      matchedCluster.width = newMaxX - newX;
      matchedCluster.height = newMaxY - newY;
    } else {
      clusters.push({ id: `img-${clusters.length}`, ...img });
    }
  }
  
  // Second pass to merge clusters that might have grown to overlap
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const c1 = clusters[i];
        const c2 = clusters[j];
        const gap = 5;
        const isOverlappingOrAdjacent = !(
          c2.x > c1.x + c1.width + gap ||
          c2.x + c2.width < c1.x - gap ||
          c2.y > c1.y + c1.height + gap ||
          c2.y + c2.height < c1.y - gap
        );
        
        if (isOverlappingOrAdjacent) {
          const newX = Math.min(c1.x, c2.x);
          const newY = Math.min(c1.y, c2.y);
          const newMaxX = Math.max(c1.x + c1.width, c2.x + c2.width);
          const newMaxY = Math.max(c1.y + c1.height, c2.y + c2.height);
          
          c1.x = newX;
          c1.y = newY;
          c1.width = newMaxX - newX;
          c1.height = newMaxY - newY;
          
          clusters.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  
  // Filter out clusters that are too extreme in aspect ratio (likely lines or borders)
  return clusters.filter(c => {
    const ratio = c.width / c.height;
    return ratio > 0.05 && ratio < 20;
  });
}

// Helper to find the bounding box of an article based on its text blocks
function getArticleBoundingBox(article: Article, zones: HLAZone[]) {
  const matchedBlocks: any[] = [];
  
  const normTitle = normalize(article.title);
  const normCaption = normalize(article.imageCaption || "");
  
  zones.forEach(zone => {
    zone.blocks.forEach(block => {
      const normBlock = normalize(block.text || "");
      if (!normBlock) return;
      
      // Match title
      if (normTitle && (normBlock.includes(normTitle) || normTitle.includes(normBlock))) {
        matchedBlocks.push(block);
      }
      // Match caption
      else if (normCaption && (normBlock.includes(normCaption) || normCaption.includes(normBlock))) {
        matchedBlocks.push(block);
      }
      // Match content (sample first few paragraphs)
      else {
        for (let i = 0; i < Math.min(3, article.content.length); i++) {
          const normContent = normalize(article.content[i]);
          if (normContent && (normContent.includes(normBlock) || normBlock.includes(normContent))) {
            matchedBlocks.push(block);
            break;
          }
        }
      }
    });
  });
  
  if (matchedBlocks.length === 0) return null;
  
  const x = Math.min(...matchedBlocks.map(b => b.bbox.x));
  const y = Math.min(...matchedBlocks.map(b => b.bbox.y));
  const maxX = Math.max(...matchedBlocks.map(b => b.bbox.x + b.bbox.width));
  const maxY = Math.max(...matchedBlocks.map(b => b.bbox.y + b.bbox.height));
  
  return { x, y, width: maxX - x, height: maxY - y, matchedBlocks };
}

export function matchImagesToArticles(
  articles: Article[], 
  images: ClusteredImage[], 
  zones: HLAZone[]
): Map<string, ClusteredImage[]> {
  const matchMap = new Map<string, ClusteredImage[]>();
  const unassignedImages = [...images];
  
  // 1. Match by Caption Proximity
  for (const article of articles) {
    if (!article.imageCaption) continue;
    
    const normCaption = normalize(article.imageCaption);
    let captionBlock = null;
    
    // Find the block corresponding to the caption
    for (const zone of zones) {
      for (const block of zone.blocks) {
        const normBlock = normalize(block.text || "");
        if (normBlock && (normBlock.includes(normCaption) || normCaption.includes(normBlock))) {
          captionBlock = block;
          break;
        }
      }
      if (captionBlock) break;
    }
    
    if (captionBlock) {
      const cx = captionBlock.bbox.x;
      const cy = captionBlock.bbox.y;
      const cw = captionBlock.bbox.width;
      const ch = captionBlock.bbox.height;
      
      // Find image closest to this caption
      let bestImgIndex = -1;
      let minDistance = Infinity;
      
      for (let i = 0; i < unassignedImages.length; i++) {
        const img = unassignedImages[i];
        
        // Check horizontal alignment (image and caption should share some X space)
        const isAlignedX = Math.max(0, Math.min(img.x + img.width, cx + cw) - Math.max(img.x, cx)) > 0;
        
        if (isAlignedX) {
          // Distance between two bounding boxes (vertical)
          let dist = 0;
          if (img.y + img.height < cy) {
            // Image is above caption
            dist = cy - (img.y + img.height);
          } else if (img.y > cy + ch) {
            // Image is below caption
            dist = img.y - (cy + ch);
          } else {
            // Overlapping vertically
            dist = 0;
          }
          
          if (dist < 150 && dist < minDistance) { // Threshold 150px
            minDistance = dist;
            bestImgIndex = i;
          }
        }
      }
      
      if (bestImgIndex !== -1) {
        const matchedImg = unassignedImages.splice(bestImgIndex, 1)[0];
        if (!matchMap.has(article.id)) matchMap.set(article.id, []);
        matchMap.get(article.id)!.push(matchedImg);
      }
    }
  }
  
  // 2. Match by Article Bounding Box Intersection
  for (const article of articles) {
    const bbox = getArticleBoundingBox(article, zones);
    if (!bbox) continue;
    
    // Expand bbox slightly to catch images
    const expandedBbox = {
      x: bbox.x - 20,
      y: bbox.y - 20,
      width: bbox.width + 40,
      height: bbox.height + 40
    };
    
    for (let i = unassignedImages.length - 1; i >= 0; i--) {
      const img = unassignedImages[i];
      
      // Calculate intersection area
      const ix = Math.max(expandedBbox.x, img.x);
      const iy = Math.max(expandedBbox.y, img.y);
      const iw = Math.min(expandedBbox.x + expandedBbox.width, img.x + img.width) - ix;
      const ih = Math.min(expandedBbox.y + expandedBbox.height, img.y + img.height) - iy;
      
      if (iw > 0 && ih > 0) {
        const intersectionArea = iw * ih;
        const imgArea = img.width * img.height;
        
        // If more than 50% of the image is inside the article's bbox
        if (intersectionArea / imgArea > 0.5) {
          const matchedImg = unassignedImages.splice(i, 1)[0];
          if (!matchMap.has(article.id)) matchMap.set(article.id, []);
          matchMap.get(article.id)!.push(matchedImg);
        }
      }
    }
  }
  
  return matchMap;
}

export async function cropImageFromCanvas(
  sourceBase64: string, 
  cropBox: { x: number, y: number, width: number, height: number },
  pageWidth: number,
  pageHeight: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error("Could not get canvas context"));
      
      // Calculate scale factor between original PDF coordinates and rendered image
      const scaleX = img.width / pageWidth;
      const scaleY = img.height / pageHeight;
      
      const sx = cropBox.x * scaleX;
      const sy = cropBox.y * scaleY;
      const sw = cropBox.width * scaleX;
      const sh = cropBox.height * scaleY;
      
      canvas.width = sw;
      canvas.height = sh;
      
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = reject;
    img.src = sourceBase64;
  });
}
