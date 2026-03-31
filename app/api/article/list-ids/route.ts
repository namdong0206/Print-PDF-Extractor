import { collection, getDocs } from 'firebase/firestore';
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

export async function GET() {
  console.log('DEBUG: Đang truy vấn danh sách ID bài báo');
  try {
    const querySnapshot = await getDocs(collection(db, 'articles')).catch((error) => {
      handleFirestoreError(error, OperationType.LIST, 'articles');
      throw error;
    });
    console.log('DEBUG: Đã truy vấn Firestore thành công, số lượng bài báo:', querySnapshot.size);
    const ids = querySnapshot.docs.map(doc => doc.id);
    console.log('DEBUG: Danh sách ID:', ids);
    return new Response(JSON.stringify(ids), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('DEBUG: Lỗi khi truy vấn Firestore:', error);
    return new Response(JSON.stringify({ error: 'Lỗi hệ thống' }), { status: 500 });
  }
}
