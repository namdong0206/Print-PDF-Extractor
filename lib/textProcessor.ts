import { TextBlock } from './geminiProcessor';

export function processArticleContent(blocks: TextBlock[]): string[] {
  // 1. Remove image captions and empty blocks
  const filteredBlocks = blocks.filter(block => {
    const trimmed = block.t.trim();
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
    const text = block.t.trim().replace(/\((Tiếp theo trang|XEM TRANG).*?\)/gi, '');

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
    
    // Detect new paragraph based on vertical gap
    let isLargeGap = false;
    if (i > 0) {
      const prevBlock = filteredBlocks[i-1];
      const verticalGap = block.y - (prevBlock.y + prevBlock.fs);
      // If gap is more than 1.5 times the font size, it's likely a new paragraph
      isLargeGap = verticalGap > block.fs * 1.5;
    }

    // Detect new paragraph based on font style change (e.g. from bold to normal)
    let isStyleChange = false;
    if (i > 0) {
      const prevBlock = filteredBlocks[i-1];
      isStyleChange = prevBlock.b !== block.b || Math.abs(prevBlock.fs - block.fs) > 2;
    }

    if ((isIndented || isLargeGap || isStyleChange) && currentParagraph) {
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
