import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export async function GET() {
  console.log('DEBUG: Đang truy vấn danh sách ID bài báo');
  try {
    const querySnapshot = await getDocs(collection(db, 'articles'));
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
