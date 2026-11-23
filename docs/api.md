# REST API & WebSocket

Mọi API (trừ đăng nhập) cần header `Authorization: Bearer <JWT>`.

## Xác thực
| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `{token, user}`. Sai → 401 |
| GET | `/api/auth/me` | Thông tin người dùng hiện tại |

## Bản vẽ (Image Uploader / Converter / G-code Viewer)
| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/drawings` | multipart: `image` (PNG/JPG ≤ 5 MB), `params` (JSON), `machineId` (tùy chọn, lấy vùng vẽ), `previewHash` (tùy chọn, trả 409 nếu G-code khác bản đã xem). → `{drawing, gcode}`. Sai định dạng → 400, quá dung lượng → 413, không có nét → 422 |
| POST | `/api/drawings/preview` | Như trên nhưng **không lưu**: trả `{gcode, params, stats, previewHash}` để cập nhật bản xem trước. |
| POST | `/api/drawings/auto` | Multipart như trên, thêm `profile` là `fast` hoặc `detail`. Trả `{candidates: [{id, label, params, metrics}], reference, tried, verified, ms, timeLimited}` và không lưu bản vẽ. Bỏ `profile` để lấy cả hai phương án từ lượt tìm Chi tiết, tương thích client cũ. 429 khi đang bận. |
| GET | `/api/drawings` | Bản vẽ của tôi |
| GET | `/api/drawings/:id/gcode` | File G-code |
| GET | `/api/drawings/:id/image` | Ảnh gốc |
| GET | `/api/converter/defaults` | Tham số mặc định |

`params`: `widthMm, heightMm, detail (1–10), threshold ("auto" | "adaptive" | 1–254), invert ("auto" | true | false), mode ("centerline" | "outline" | "fill"), smoothing (0–3), simplifyMm (mm, null để suy ra từ detail), hatchRatio (0,6–1 lần bề rộng bút), fillStrategy ("legacy" | "inset-x" | "inset-y"), rasterPx (210–1280 px, null để suy ra từ detail), despeckle (bool), penWidthMm`. Thông số lệnh bút và tốc độ ở kết quả lấy từ cấu hình HTrang trên máy chủ.

`stats` / `metrics` gồm `iou` (% diện tích giao/hợp), `inkRecall` (% mực gốc phủ đúng), `inkPrecision` (% mực đầu ra nằm đúng vị trí), `coverage` / `precision` có dung sai, `score` (80% IoU + 20% F1 theo dung sai), `chamferMm`, `extraMm`, `missMm`, `minutes`, `paths`, `drawLengthMm`, `travelMm`. Vòng kiểm tra cuối phát lại G-code và chấm trên ảnh tham chiếu cạnh dài 960 px.

Chi tiết ưu tiên IoU trong các phương án giữ đủ diện tích nét gốc. Nhanh tìm trong không gian nhỏ hơn, chọn đường chạy có thời gian vẽ ước tính ngắn trong số phương án cách kết quả tốt nhất tối đa 4 điểm IoU và 5 điểm cho mỗi số đo `inkRecall`, `inkPrecision` và `score`. Cả hai giữ kích thước trong phạm vi máy và bề rộng mực do người dùng chọn. Cấu hình HTrang cố định lệnh bút `G0 Z5` / `G1 Z0 F300`, vẽ ở `F900` và để firmware điều khiển rapid `G0`. Các thiết lập chuyển động cũ do client gửi không ghi đè lên cấu hình này.

Worker dùng giới hạn máy chủ 14,5 giây cho Nhanh và 44,5 giây cho Chi tiết, chưa gồm thời gian tải ảnh. Khi phần tìm kiếm chạm ngân sách, API trả phương án đã kiểm tra tốt nhất với `timeLimited: true`. Nếu chưa có phương án đã kiểm tra khi chạm giới hạn, trả 503. Thời gian vẽ là ước lượng, cần đo trên máy thật.

## Máy & phiên vẽ
| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/machines` | Danh sách máy + trạng thái + số phiên chờ |
| POST | `/api/jobs` | `{drawingId, machineId}` → tạo phiên, vào hàng đợi FIFO của máy. 409 nếu G-code cũ không hợp cấu hình hoặc vượt vùng máy. |
| GET | `/api/jobs` | Phiên của tôi (`?all=1` cho admin) |
| GET | `/api/jobs/:id` | Chi tiết + lịch sử sự kiện |
| POST | `/api/jobs/:id/pause` \| `resume` \| `cancel` | Điều khiển phiên (409 nếu trạng thái không hợp lệ) |

Trạng thái phiên: `QUEUED → SENDING → READY → DRAWING ⇄ PAUSED → COMPLETED | CANCELLED | FAILED`.

## Quản trị (`role = admin`, người dùng thường → 403)
| Method | Path | Mô tả |
|---|---|---|
| GET/POST | `/api/admin/machines` | Xem / thêm máy (sinh token MQTT) |
| PATCH | `/api/admin/machines/:id` | Đổi tên, bật/tắt, vùng vẽ |
| POST | `/api/admin/machines/:id/token` | Cấp lại token |
| POST | `/api/admin/machines/:id/home` | Gửi lệnh về gốc |
| GET/POST | `/api/admin/users` | Xem / tạo tài khoản |
| PATCH | `/api/admin/users/:id` | Khóa/mở khóa, đổi vai trò |
| GET | `/api/admin/queue` | Toàn bộ hàng đợi đang chạy |

## WebSocket `ws://<host>/ws?token=<JWT>`
Server đẩy `{type, data, ts}`:
- `machine.status` — máy đổi trạng thái / online / offline (`reason`: `LWT`, `HEARTBEAT_TIMEOUT`)
- `job.status` — phiên đổi trạng thái/tiến độ (chỉ gửi cho chủ phiên + admin)
- `job.completed`, `job.failed`
