import { TextBlock, Article } from './geminiProcessor';

export function processArticleForDisplay(article: Article): Article {
  let { author, content, imageCaption } = article;
  let newContent = [...content];

  // 1. Author Processing
  if (newContent.length > 0) {
    const firstPara = newContent[0];
    
    // Case 1: Author in Author field AND at start of Content
    if (author && firstPara.toLowerCase().startsWith(author.toLowerCase())) {
      newContent[0] = firstPara.substring(author.length).trim().replace(/^[-,: ]+/, '');
    } 
    // Case 2: Author only in Content
    else if (!author) {
      const match = firstPara.match(/^(Bài và ảnh:)\s*(.*)/i);
      if (match) {
        author = match[2].trim();
        newContent[0] = firstPara.substring(match[0].length).trim();
      }
    }
  }

  // 2. Photo Caption Processing
  const captionRegex = /^(Ảnh:|Ảnh)\s*(.*)/i;
  for (let i = 0; i < newContent.length; i++) {
    const match = newContent[i].match(captionRegex);
    if (match) {
      const foundCaption = match[0].trim();
      
      // If we don't have a caption, or this is a new one, update it
      if (!imageCaption) {
        imageCaption = foundCaption;
        newContent.splice(i, 1);
        i--; // Adjust index
      } 
      // If we already have a caption, and it matches, remove from content
      else if (imageCaption.toLowerCase().includes(foundCaption.toLowerCase())) {
        newContent.splice(i, 1);
        i--;
      }
    }
  }

  // 3. Subheading Processing (ensure they are kept as paragraphs)
  // The current structure already treats them as paragraphs. 
  // No special action needed, just ensure they are not filtered out.

  return { 
    ...article, 
    author, 
    content: newContent.filter(p => p.length > 0), 
    imageCaption 
  };
}

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
