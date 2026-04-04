# Checkpoint Documentation - 2026-04-04

## 1. Tổng quan ứng dụng
Ứng dụng phân tích layout báo in và trích xuất nội dung từ file PDF.

## 2. Quy trình xử lý (Workflow)
1. **Client-side:**
   - Người dùng tải file PDF.
   - Render PDF thành hình ảnh (sử dụng `pdfjs-dist`).
   - Phân tích layout (HLA - Hybrid Layout Analysis) để tạo các `zones` (vùng nội dung).
2. **Server-side (API Route):**
   - Client gửi dữ liệu `zones` và hình ảnh trang báo lên API `/api/extract-articles`.
   - Server gọi Gemini API (sử dụng `@google/genai`) để trích xuất bài báo từ dữ liệu zones và hình ảnh.
   - Server trả về JSON chứa các bài báo đã được ghép hoàn chỉnh.
3. **Client-side (Xử lý kết quả):**
   - Nhận JSON từ server.
   - Map dữ liệu vào cấu trúc `Article`.
   - Hiển thị kết quả cho người dùng.

## 3. Cấu trúc thư mục chính
- `/app/`: Next.js App Router.
  - `/api/extract-articles/route.ts`: API route xử lý Gemini trên server.
- `/lib/`:
  - `geminiProcessor.ts`: Chứa logic gọi API (đã refactor để gọi sang server-side API).
  - `hlaService.ts`, `layoutService.ts`, `segmentationService.ts`: Xử lý layout PDF.
  - `types.ts`: Định nghĩa kiểu dữ liệu.

## 4. Các thư viện chính
- `next`: Framework chính.
- `@google/genai`: SDK gọi Gemini API.
- `pdfjs-dist`: Render PDF.
- `tailwindcss`: Styling.
- `lucide-react`: Icons.

## 5. Các tối ưu hóa đã thực hiện
- **Server-side processing:** Chuyển logic gọi Gemini lên server để bảo mật API key và giảm tải client.
- **Tắt ThinkingLevel:** Cấu hình `thinkingLevel: ThinkingLevel.MINIMAL` để tăng tốc độ phản hồi của Gemini.
- **Tối ưu JSON payload:** Loại bỏ các trường không cần thiết (`id`, `ind`) trước khi gửi lên server.
- **Hybrid Model:** Sử dụng kết hợp HLA (layout) và Text (nội dung) để Gemini trích xuất chính xác.

## 6. Giao diện
- Giao diện tập trung vào việc hiển thị tiến trình xử lý và kết quả trích xuất.
- Sử dụng Tailwind CSS cho thiết kế.
