import { BoundingBox } from './types';

export interface GeminiLayoutElement {
  label: string;
  box_2d: number[]; // [ymin, xmin, ymax, xmax]
  text?: string;
  reading_order: number;
  parent_column_index?: number;
  article_id?: string;
}

export async function analyzeLayoutWithGemini(
  base64Image: string,
  pageNumber: number,
  fileName: string
): Promise<BoundingBox[]> {
  const response = await fetch('/api/analyze-layout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      base64Image,
      pageNumber,
      fileName
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to analyze layout with Gemini');
  }

  const { elements } = await response.json();

  // Convert Gemini coordinates [ymin, xmin, ymax, xmax] (0-1000)
  // to BoundingBox coordinates (actual pixel coordinates or relative)
  // We'll keep them as relative 0-1000 for now and scale them in the UI
  return elements.map((el: GeminiLayoutElement, i: number) => {
    const [ymin, xmin, ymax, xmax] = el.box_2d;
    return {
      id: `gemini-${i}`,
      x: xmin,
      y: ymin,
      width: xmax - xmin,
      height: ymax - ymin,
      label: el.label as any,
      confidence: 1.0,
      text: el.text,
      reading_order: el.reading_order,
      parent_column_index: el.parent_column_index,
      article_id: el.article_id
    };
  });
}
