import { doc, getDoc } from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log('DEBUG: ID nhận được từ params:', id);

  try {
    console.log('DEBUG: Đang truy vấn Firestore với ID:', id);
    const docRef = doc(db, 'articles', id);
    const docSnap = await getDoc(docRef).catch((error) => {
      handleFirestoreError(error, OperationType.GET, `articles/${id}`);
      throw error;
    });

    if (!docSnap.exists()) {
      console.log('DEBUG: Không tìm thấy bài báo với ID:', id);
      return new Response(`Bài báo không tồn tại. ID: ${id}`, { status: 404 });
    }
    
    const article = docSnap.data();
    console.log('DEBUG: Đã tìm thấy bài báo:', article.title);

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
