# Checkpoint: 2026-04-04

## 1. Tổng quan dự án
Hệ thống bóc tách và phân tích bố cục báo in tự động (Print PDF Extractor). Ứng dụng cho phép người dùng upload file PDF báo in, tự động nhận diện các vùng nội dung, trích xuất bài báo, ghép các phần bài báo bị chia cắt, và xuất kết quả ra file Word hoặc file nén (.zip).

## 2. Cấu trúc dự án
- `/app`: Chứa các trang và layout của Next.js (App Router).
- `/lib`: Chứa các dịch vụ xử lý chính:
    - `geminiProcessor.ts`: Xử lý trích xuất bài báo bằng Gemini AI.
    - `hlaService.ts`: Phân tích bố cục báo in (Hybrid Layout Analysis).
    - `layoutService.ts`: Dịch vụ phân tích layout PDF.
    - `segmentationService.ts`: Phân đoạn vùng nội dung.
    - `textProcessor.ts`: Xử lý văn bản sau trích xuất.
    - `wordExport.ts`: Xuất bài báo ra file Word.
    - `firebase.ts`: Cấu hình Firebase.
    - `cacheService.ts`: Dịch vụ cache kết quả.
    - `worker.ts`: Web worker xử lý layout.
- `/server`: Chứa các script Python hỗ trợ xử lý (nếu có).
- `/firestore.rules`: Quy tắc bảo mật Firestore.

## 3. Quy trình hoạt động
1. **Upload:** Người dùng upload file PDF.
2. **Phân tích Layout:** Sử dụng `pdfjs-dist` để render trang PDF thành hình ảnh, sau đó dùng `hlaService` (Hybrid Layout Analysis) để nhận diện các vùng (zones).
3. **Trích xuất nội dung:** Sử dụng Gemini AI (`geminiProcessor`) để trích xuất văn bản từ các vùng đã nhận diện.
4. **Xử lý hậu kỳ:** Ghép các phần bài báo bị chia cắt, làm sạch văn bản (`textProcessor`).
5. **Lưu trữ:** Lưu bài báo đã trích xuất vào Firestore.
6. **Xuất kết quả:** Người dùng có thể xuất bài báo ra file Word hoặc tải xuống tất cả bài báo dưới dạng file nén (.zip).

## 4. Các thư viện chính
- **Framework:** Next.js 15 (App Router), React 19.
- **AI/ML:** `@google/genai` (Gemini API).
- **PDF Processing:** `pdfjs-dist`.
- **Database:** `firebase` (Firestore).
- **Styling:** `tailwindcss` (v4).
- **Animations:** `motion` (framer-motion).
- **Icons:** `lucide-react`.
- **Utilities:** `comlink` (Web Workers), `docx`, `jszip`, `file-saver`.

## 5. Giao diện (UI)
- Sử dụng Tailwind CSS với phong cách hiện đại, tối giản.
- Bố cục 2 cột:
    - Cột trái: Danh sách file, nút điều khiển xử lý, danh sách bài báo đã trích xuất.
    - Cột phải: Xem chi tiết nội dung bài báo, các nút chức năng xuất file.
- Hỗ trợ responsive, tương thích với các thiết bị.

## 6. Yêu cầu hiện tại
- Đã khắc phục lỗi biên dịch `pdfjs-dist` bằng cách thêm `@types/pdfjs-dist` và tạo file khai báo kiểu `pdfjs-dist.d.ts`.
- Dự án đã được dọn dẹp cấu trúc, làm việc trực tiếp từ thư mục gốc.
