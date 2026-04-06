import { TextBlock } from './geminiProcessor';

export function cleanText(text: string): string {
  return text
    .replace(/\(Tiếp theo trang \d+\)/gi, '')
    .replace(/\(Xem trang \d+\)/gi, '')
    .replace(/\[.*?\]/g, '') // Remove [..]
    .replace(/\s+/g, ' ')
    .trim();
}

export function processArticleContent(blocks: TextBlock[]): string[] {
  // 1. Remove image captions and empty blocks
  const filteredBlocks = blocks.filter(block => {
    const trimmed = cleanText(block.t);
    if (!trimmed) return false;
    // Keywords for captions
    return !/^(Ảnh|Hình|Chú thích|Credit):/i.test(trimmed);
  });

  if (filteredBlocks.length === 0) return [];

  const paragraphs: string[] = [];
  let currentParagraph = '';
  
  // Track the base X coordinate for the current column
  let baseX = filteredBlocks[0].x;

  for (let i = 0; i < filteredBlocks.length; i++) {
    const block = filteredBlocks[i];
    const text = cleanText(block.t);

    // Detect column switch or significant layout change
    if (i > 0) {
      const prevBlock = filteredBlocks[i-1];
      
      // If y jumps up significantly (back to top of page/column)
      // or if x jumps significantly (to a different column)
      const isNewColumn = block.y < prevBlock.y - 100 || Math.abs(block.x - prevBlock.x) > 50;
      
      if (isNewColumn) {
        // Reset baseX for the new column
        // We look ahead a few blocks to find the most common x in this new area
        const window = filteredBlocks.slice(i, i + 5);
        if (window.length > 0) {
          baseX = Math.min(...window.map(b => b.x));
        } else {
          baseX = block.x;
        }
      }
    }

    // A block is indented if its x is significantly greater than the baseX of the current column
    const isIndented = block.x > baseX + 10;

    if (isIndented && currentParagraph) {
      // Start a new paragraph
      paragraphs.push(currentParagraph.trim());
      currentParagraph = text;
    } else {
      // Continue current paragraph
      if (currentParagraph) {
        // Handle hyphenation at the end of the previous block
        if (currentParagraph.endsWith('-')) {
          currentParagraph = currentParagraph.slice(0, -1) + text;
        } else {
          currentParagraph += ' ' + text;
        }
      } else {
        currentParagraph = text;
      }
      
      // If this block is NOT indented, it might be a better candidate for baseX
      // (e.g. if the first block of a column happened to be indented)
      if (block.x < baseX + 2) {
        baseX = block.x;
      }
    }
  }
  
  if (currentParagraph) {
    paragraphs.push(currentParagraph.trim());
  }

  return paragraphs;
}
