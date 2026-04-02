# Checkpoint 3: Multi-Key Support & Pre-Coverage Validation
**Date:** 2026-04-02

## Trạng thái hiện tại (Current State)
- **Tính năng chính:** Trích xuất bài báo từ PDF báo in, phân tích layout, gom nhóm các khối text.
- **Gemini API Integration:** Đã hỗ trợ xoay vòng nhiều API Key (`NEXT_PUBLIC_CUSTOM_GEMINI_API_KEYS` và `NEXT_PUBLIC_GEMINI_API_KEY`). Đã có logic tự động đẩy key mặc định của AI Studio xuống cuối để ưu tiên dùng key của user.
- **Xử lý lỗi:** Đã có logic bắt lỗi `429 Quota Exceeded` và tự động chuyển sang model/key tiếp theo.
- **Giao diện:** Đã có UI hiển thị log chi tiết quá trình gọi API, thời gian phản hồi (HLATime), và kích thước payload.

## Cấu trúc thư mục Backup
Toàn bộ mã nguồn, cấu hình (`package.json`, `next.config.ts`, `tsconfig.json`, `tailwind.config.ts`...), và logic (đặc biệt là `lib/geminiProcessor.ts` và `app/page.tsx`) đã được copy nguyên vẹn vào thư mục `backup_v3_20260402`.

## Kế hoạch tiếp theo (Next Steps)
Triển khai giải pháp **Kiểm tra độ phủ (Coverage Validation)** và **Quy trình tự động sửa lỗi (Self-Correction Flow)**:
1. Viết hàm chuẩn hóa chuỗi (xóa khoảng trắng, dấu câu).
2. Viết hàm đối chiếu `aiGiantNormalizedString` với `sourceBlocks`.
3. Nhận diện các Orphan Text (đoạn văn bị bỏ sót).
4. Cập nhật vòng lặp gọi API trong `geminiProcessor.ts` để tự động Retry (mớm lại Orphan Text) và Nâng cấp Model (lên `gemini-3.1-pro-preview`) nếu cần thiết.
5. Hiển thị cảnh báo trên UI nếu vẫn còn Orphan Text sau 3 lần thử.
