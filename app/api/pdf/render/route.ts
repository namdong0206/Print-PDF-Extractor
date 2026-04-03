import { NextRequest, NextResponse } from 'next/server';
import * as PImage from 'pureimage';
import { PassThrough } from 'stream';

// Polyfill for CanvasFactory
class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = PImage.make(width, height);
    const context = canvas.getContext('2d');
    return {
      canvas,
      context,
    };
  }

  reset(canvasAndContext: any, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: any) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
    const pdfjs = pdfjsModule.default || pdfjsModule;
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const pageNum = parseInt(formData.get('pageNum') as string || '1');
    const scale = parseFloat(formData.get('scale') as string || '2.0');

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    // Load PDF
    const loadingTask = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true, // Important for Node.js
      cMapUrl: 'https://unpkg.com/pdfjs-dist@5.6.205/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@5.6.205/standard_fonts/',
    });
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(pageNum);

    // Render to image
    const viewport = page.getViewport({ scale });
    const canvasFactory = new NodeCanvasFactory();
    const { canvas, context } = canvasFactory.create(
      Math.floor(viewport.width),
      Math.floor(viewport.height)
    );

    const renderContext = {
      canvasContext: context,
      viewport: viewport,
      canvasFactory: canvasFactory,
    };

    await page.render(renderContext).promise;

    // Convert to PNG buffer
    const passThrough = new PassThrough();
    const chunks: Buffer[] = [];
    
    const encodePromise = new Promise<void>((resolve, reject) => {
      passThrough.on('data', (chunk) => chunks.push(chunk));
      passThrough.on('end', () => resolve());
      passThrough.on('error', (err) => reject(err));
      
      PImage.encodePNGToStream(canvas, passThrough)
        .catch(reject);
    });

    await encodePromise;

    const buffer = Buffer.concat(chunks);
    const base64 = buffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64}`;

    return NextResponse.json({ image: dataUrl });
  } catch (error: any) {
    console.error('Error rendering PDF on backend:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
