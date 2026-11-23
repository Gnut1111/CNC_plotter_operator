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
| POST | `/api/drawings/auto` | Như trên nhưng **không lưu**: dò theo ngân sách 7,5 giây, trả `{candidates: [{id, label, params, metrics}], reference, tried, ms, timeLimited}` với Chi tiết và Nhanh. Mỗi lần chạy một yêu cầu. 429 khi đang bận, 503 nếu chạm giới hạn HTTP 9,5 giây |
| GET | `/api/drawings` | Bản vẽ của tôi |
| GET | `/api/drawings/:id/gcode` | File G-code |
| GET | `/api/drawings/:id/image` | Ảnh gốc |
| GET | `/api/converter/defaults` | Tham số mặc định |

`params`: `widthMm, heightMm, detail (1–10), threshold ("auto" | "adaptive" | 1–254), invert ("auto" | true | false), mode ("centerline" | "outline" | "fill"), smoothing (0–3), simplifyMm (mm, null để suy ra từ detail), hatchRatio (0,6–1 lần bề rộng bút), despeckle (bool), penWidthMm, drawFeed, travelFeed, penUp, penDown`.

`stats` / `metrics` của bản vẽ: `chamferMm` (sai lệch trung bình so với ảnh gốc, mm — càng nhỏ càng giống), `extraMm` (vẽ thừa), `missMm` (bỏ sót), `iou` (% diện tích nét giao/hợp), `coverage` và `precision` (% nét giữ được và % mực đi đúng), `score` (60% IoU + 40% F1 theo dung sai nét), `minutes` (thời gian vẽ ước lượng), `paths`, `drawLengthMm`, `travelMm`, `binarize` (cách tách nét đã chọn).

Chi tiết chọn điểm cao nhất trong các cấu hình đã thử. Nhanh chọn thời gian máy ngắn nhất trong các cấu hình mất tối đa 6 điểm tổng, 8 điểm coverage và 8 điểm precision so với Chi tiết. Ước lượng thời gian gồm di chuyển, tăng giảm tốc theo từng đoạn và nâng hạ bút. Cả hai giữ kích thước, bề rộng bút, tốc độ và lệnh servo đang chọn. Khi dùng tự dò, lệnh servo theo giao thức là `M5` và `M3 S0` đến `M3 S180`. Số liệu máy là mô phỏng và cần đối chiếu trên ESP32 thực tế.

## Máy & phiên vẽ
| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/machines` | Danh sách máy + trạng thái + số phiên chờ |
| POST | `/api/jobs` | `{drawingId, machineId}` → tạo phiên, vào hàng đợi FIFO của máy |
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
