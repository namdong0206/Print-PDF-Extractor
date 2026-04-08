export interface BoundingBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: 'Text Box' | 'Image Box' | 'Text Region' | 'Image Region' | 'Headline' | 'Sapo' | 'Author' | 'Content' | 'Caption' | 'Header' | 'Footer' | 'Horizontal Line' | 'Vertical Line' | 'Footer Note' | 'ToContinue' | 'ContinuePage' | 'Filled Box';
  confidence: number;
  text?: string;
  fontSize?: number;
  fontName?: string;
  isBold?: boolean;
  color?: string;
}

export interface ArticleRegion {
  id: string;
  polygon: { x: number; y: number }[];
  bbox: { x: number; y: number; width: number; height: number };
}
