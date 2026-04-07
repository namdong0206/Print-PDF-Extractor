export async function pdfToImages(file: File): Promise<string[]> {
  // @ts-ignore
  const pdfjsLib = await import('pdfjs-dist');
  
  // Set up the worker for pdfjs-dist
  if (typeof window !== 'undefined' && 'Worker' in window) {
    // @ts-ignore
    pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
  }

  const arrayBuffer = await file.arrayBuffer();
  // @ts-ignore
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const images: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 }); // Higher scale for better OCR
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (context) {
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({ canvasContext: context, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      images.push(dataUrl.split(',')[1]); // Only the base64 part
    }
  }

  return images;
}
