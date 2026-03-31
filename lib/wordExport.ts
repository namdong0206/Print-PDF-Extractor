import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { Article } from './geminiProcessor';

const removeVietnameseTones = (str: string) => {
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  str = str.replace(/đ/g, "d");
  str = str.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
  str = str.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
  str = str.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, "I");
  str = str.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
  str = str.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
  str = str.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, "Y");
  str = str.replace(/Đ/g, "D");
  // Some system encode vietnamese combining accent as individual utf-8 characters
  str = str.replace(/\u0300|\u0301|\u0303|\u0309|\u0323/g, ""); // ̀ ́ ̃ ̉ ̣  huyền, sắc, ngã, hỏi, nặng
  str = str.replace(/\u02C6|\u0306|\u031B/g, ""); // ˆ ̆ ̛  Â, Ê, Ă, Ơ, Ư
  return str;
};

const getSafeFilename = (title: string) => {
  return removeVietnameseTones(title)
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .substring(0, 50) || 'bai_bao';
};

export const generateWordDocument = async (article: Article): Promise<Blob> => {
  const children: Paragraph[] = [];

  // Title
  children.push(
    new Paragraph({
      text: article.title,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
    })
  );

  // Author
  if (article.author) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Tác giả: ${article.author}`,
            bold: true,
          }),
        ],
        spacing: { after: 200 },
      })
    );
  }

  // Content
  article.content.forEach((para) => {
    children.push(
      new Paragraph({
        text: para,
        spacing: { after: 200 },
      })
    );
  });

  // Image Caption
  if (article.imageCaption) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Chú thích ảnh: ${article.imageCaption}`,
            italics: true,
          }),
        ],
        spacing: { before: 200, after: 200 },
      })
    );
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: children,
      },
    ],
  });

  return await Packer.toBlob(doc);
};

export const exportArticleToWord = async (article: Article) => {
  const blob = await generateWordDocument(article);
  // Sanitize filename
  const safeTitle = getSafeFilename(article.title);
  saveAs(blob, `${safeTitle}.docx`);
};

export const exportAllArticlesToZip = async (articles: Article[]) => {
  const zip = new JSZip();

  for (const article of articles) {
    const blob = await generateWordDocument(article);
    const safeTitle = getSafeFilename(article.title);
    // Ensure unique filenames if there are duplicates
    let filename = `${safeTitle}.docx`;
    let counter = 1;
    while (zip.file(filename)) {
      filename = `${safeTitle}_${counter}.docx`;
      counter++;
    }
    zip.file(filename, blob);
  }

  const content = await zip.generateAsync({ type: 'blob' });
  saveAs(content, 'bai_bao_da_trich_xuat.zip');
};
