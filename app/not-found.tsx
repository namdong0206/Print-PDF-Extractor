import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#FDFCFB] p-6 text-center">
      <h2 className="text-3xl font-bold text-gray-900 mb-4">Không tìm thấy trang</h2>
      <p className="text-gray-600 mb-8">Trang bạn đang tìm kiếm không tồn tại.</p>
      <Link href="/" className="bg-[#1A1A1A] text-white px-6 py-3 rounded-full font-bold hover:bg-black transition-colors">
        Về trang chủ
      </Link>
    </div>
  );
}
