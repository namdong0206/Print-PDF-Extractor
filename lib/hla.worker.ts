import { HLAService } from './hlaService';

self.onmessage = async (e: MessageEvent) => {
  const { textItems, vectorData, pageWidth, pageHeight, requestId } = e.data;
  
  try {
    const hlaService = new HLAService();
    const zones = await hlaService.analyze(textItems, vectorData, pageWidth, pageHeight);
    
    self.postMessage({
      requestId,
      zones,
      success: true
    });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error),
      success: false
    });
  }
};
