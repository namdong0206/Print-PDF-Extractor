import { HLAZone, HLAService } from './hlaService';
import { VectorData, extractVectorData } from './vectorService';

/**
 * Orchestrator for Hybrid Layout Analysis.
 * Decides whether to use a Web Worker or run directly on the main thread.
 * This file exists to break circular dependencies between HLAService and Workers.
 */
export const parseNewspaperLayoutHybrid = async (page: any): Promise<{ 
  zones: HLAZone[], 
  pageWidth: number, 
  pageHeight: number, 
  images: any[], 
  vectorData: VectorData 
}> => {
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

    // 3. HLA Analysis using Web Worker if available
    let zones: HLAZone[];
    if (typeof Worker !== 'undefined') {
      zones = await new Promise((resolve, reject) => {
        // Use a relative path to the worker file
        const worker = new Worker(new URL('./hla.worker.ts', import.meta.url));
        worker.onmessage = (e) => {
          if (e.data.success) resolve(e.data.zones);
          else reject(new Error(e.data.error));
          worker.terminate();
        };
        worker.onerror = (err) => {
          reject(err);
          worker.terminate();
        };
        worker.postMessage({
          textItems,
          vectorData,
          pageWidth,
          pageHeight,
          requestId: Date.now()
        });
      });
    } else {
      const hlaService = new HLAService();
      zones = await hlaService.analyze(textItems, vectorData, pageWidth, pageHeight);
    }

    return { zones, pageWidth, pageHeight, images: vectorData.images, vectorData };
  } catch (error) {
    console.error("Hybrid Layout analysis failed:", error);
    throw error;
  }
};
