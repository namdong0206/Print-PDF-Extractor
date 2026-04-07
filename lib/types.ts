export interface BoundingBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: 'Text Box' | 'Image Box' | 'Text Region' | 'Image Region' | 'Headline' | 'Sapo' | 'Author' | 'Content' | 'Caption' | 'Header' | 'Footer' | 'Horizontal Line' | 'Vertical Line' | 'Footer Note' | 'ToContinue' | 'ContinuePage' | 'Filled Box' | 'TITLE' | 'AUTHOR' | 'SAPO' | 'BODY_COLUMN' | 'PARAGRAPH' | 'IMAGE' | 'CAPTION' | 'HEADER' | 'FOOTER' | 'ADVERTISEMENT' | 'PAGE_NUMBER' | 'SEE_PAGE' | 'FROM_PAGE';
  confidence: number;
  text?: string;
  fontSize?: number;
  fontName?: string;
  isBold?: boolean;
  color?: string;
  reading_order?: number;
  parent_column_index?: number;
  article_id?: string;
}

export interface ArticleRegion {
  id: string;
  polygon: { x: number; y: number }[];
  bbox: { x: number; y: number; width: number; height: number };
}
