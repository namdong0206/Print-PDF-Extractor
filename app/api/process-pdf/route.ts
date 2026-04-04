import { NextRequest, NextResponse } from 'next/server';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseNewspaperLayoutHybrid } from '@/lib/hlaService';
import { extractArticlesHybrid } from '@/lib/geminiProcessor';
import { createCanvas } from 'canvas';

// pdfjs-dist legacy build in Node.js environment
// No explicit workerSrc assignment needed for basic parsing

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const pageNumber = parseInt(formData.get('pageNumber') as string || '1');
    const fileName = formData.get('fileName') as string || 'document.pdf';
    const metadataPageNum = parseInt(formData.get('metadataPageNum') as string || pageNumber.toString());

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    console.log(`[API] Processing PDF: ${fileName}, Page: ${pageNumber}, Size: ${uint8Array.length} bytes`);

    const loadingTask = pdfjs.getDocument({
      data: uint8Array,
      useSystemFonts: true,
      disableFontFace: true,
      cMapUrl: 'https://unpkg.com/pdfjs-dist@5.6.205/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@5.6.205/standard_fonts/',
    });
    console.log(`[API] Loading PDF document...`);
    const pdfDoc = await loadingTask.promise;
    console.log(`[API] PDF document loaded. Total pages: ${pdfDoc.numPages}`);
    const page = await pdfDoc.getPage(pageNumber);
    console.log(`[API] Page ${pageNumber} loaded.`);

    // 1. Render page to image for Gemini
    const viewport = page.getViewport({ scale: 2.0 });
    console.log(`[API] Rendering page to canvas: ${viewport.width}x${viewport.height}`);
    
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    
    try {
      // @ts-ignore
      await page.render({
        canvasContext: context,
        viewport: viewport,
      }).promise;
      console.log(`[API] Page rendered to canvas.`);
    } catch (renderError: any) {
      console.error("[API] Error rendering PDF page to canvas:", renderError);
      throw new Error(`Failed to render PDF page: ${renderError.message}`);
    }
    
    const imageBase64 = canvas.toDataURL('image/jpeg', 0.8);
    console.log("[API] Canvas toDataURL complete.");

    // 2. Hybrid Layout Analysis (Heuristic)
    console.time(`HLATime-${fileName}-${pageNumber}`);
    const { zones } = await parseNewspaperLayoutHybrid(page);
    console.timeEnd(`HLATime-${fileName}-${pageNumber}`);

    // Optimize zones for client response (remove heavy items)
    const optimizedZonesForClient = zones.map(zone => ({
      ...zone,
      blocks: zone.blocks.map(block => {
        const { items, ...rest } = block;
        return rest;
      })
    }));

    // 3. Semantic Extraction (Gemini)
    const extractedArticles = await extractArticlesHybrid(zones, metadataPageNum, fileName, imageBase64);

    return NextResponse.json({ articles: extractedArticles, zones: optimizedZonesForClient });
  } catch (error: any) {
    console.error("Error in process-pdf API:", error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
