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
| POST | `/api/drawings` | multipart: `image` (PNG/JPG ≤ 5 MB), `params` (JSON), `machineId` (tùy chọn, lấy vùng vẽ). → `{drawing, gcode}`. Sai định dạng → 400, quá dung lượng → 413, không có nét → 422 |
| GET | `/api/drawings` | Bản vẽ của tôi |
| GET | `/api/drawings/:id/gcode` | File G-code |
| GET | `/api/drawings/:id/image` | Ảnh gốc |
| GET | `/api/converter/defaults` | Tham số mặc định |

`params`: `widthMm, heightMm, detail (1–10), threshold (1–254), invert, mode ("centerline"|"outline"), smoothing (0–3), drawFeed, travelFeed, penUp, penDown`.

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
