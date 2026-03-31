import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const docRef = doc(db, 'articles', id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return new Response('Bài báo không tồn tại', { status: 404 });
    }

    const article = docSnap.data();

    const html = `
      <!DOCTYPE html>
      <html lang="vi">
      <head>
        <meta charset="UTF-8">
        <title>${article.title}</title>
        <style>
          body { font-family: sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 800px; margin: 40px auto; padding: 20px; }
          h1 { font-size: 2.5rem; font-weight: bold; margin-bottom: 20px; }
          .meta { color: #666; margin-bottom: 30px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
          .lead { font-size: 1.25rem; font-weight: bold; font-style: italic; margin-bottom: 30px; color: #333; }
          p { margin-bottom: 20px; font-size: 1.1rem; }
        </style>
      </head>
      <body>
        <h1>${article.title}</h1>
        <div class="meta">
          <p>Tác giả: ${article.author || 'Không rõ'}</p>
        </div>
        ${article.lead ? `<div class="lead">${article.lead}</div>` : ''}
        <div class="content">
          ${article.content.map((para: string) => `<p>${para}</p>`).join('')}
        </div>
      </body>
      </html>
    `;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });
  } catch (error) {
    return new Response('Lỗi hệ thống', { status: 500 });
  }
}
