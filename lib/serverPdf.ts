import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';

// Set up the worker for Node.js
if (typeof window === 'undefined') {
  // @ts-ignore
  const { PDFWorker } = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFWorker;
}

export async function getPdfDoc(buffer: ArrayBuffer) {
  const loadingTask = pdfjs.getDocument({
    data: buffer,
    useSystemFonts: true,
    disableFontFace: true,
  });
  return await loadingTask.promise;
}

export async function renderPageToImage(pdfDoc: any, pageNum: number): Promise<string> {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 2.0 });
  
  // On Node.js, we need a canvas implementation. 
  // Since we don't have 'canvas' package installed yet, let's see if we can use something else or if we should install it.
  // Actually, for Gemini, we can just send the text and layout zones. 
  // But the current implementation also sends the image for better accuracy.
  
  // If we want to render to image on server, we usually need 'canvas' or 'node-canvas'.
  // Let's assume for now we might not need the image if we have good HLA zones, 
  // OR we can try to use a different approach.
  
  // Wait, the user's package.json has 'pureimage'. Let's try that.
  return ""; // Placeholder
}
