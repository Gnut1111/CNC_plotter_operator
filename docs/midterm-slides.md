# Báo cáo giữa kì (W7) — Dàn ý slide

Giai đoạn Implementation W5–W9: **Coding · HW · Integrating · Debugging**. Báo cáo W7 = giữa kì, W9 = cuối giai đoạn.
Nguyên tắc: thầy muốn thấy **đã làm được gì thật** (ảnh, video, số liệu), không lặp lại slide đề cương.

## A. Danh sách slide đề xuất (~15–18 slide, 10–12 phút)

| # | Slide | Nội dung chính | Ai chuẩn bị |
|---|---|---|---|
| 1 | Bìa | Tên đề tài, GVHD, nhóm Pixel2Plot, "Báo cáo giữa kì – W7" | |
| 2 | Nhắc lại đề tài | 1 slide: mục tiêu + sơ đồ kiến trúc tổng quan (dùng lại hình cũ) | |
| 3 | Phân công & kế hoạch | Bảng ai làm khối nào + Gantt W5–W9 (đánh dấu đang ở W7) | |
| 4 | Tiến độ tổng thể | Bảng % hoàn thành từng khối: Web, Server, Firmware lõi 1, Firmware lõi 2, Phần cứng/cơ khí, Tích hợp | |
| 5–9 | **Coding – Web & Server** | Xem phần B bên dưới (đã soạn sẵn) | Tuấn |
| 10–11 | Coding – Firmware | RTOS 2 lõi (task mạng / task CNC), MQTT client + nhận file + CRC, parser G-code, nội suy Bresenham/DDA, điều khiển gia tốc, servo bút. Ảnh code/flowchart + video máy chạy lệnh tay | |
| 12–13 | HW | Sơ đồ nguyên lý (nguồn 12V→5V/3V3, driver, E-Stop, Limit), danh sách linh kiện + chi phí (BOM), ảnh khung cơ khí đã lắp, đo đạc (bước/mm, độ rơ) | |
| 14 | Integrating | Sơ đồ những liên kết đã chạy được: Web ⇄ Server ⇄ MQTT ⇄ (máy giả lập / ESP32). Đánh dấu xanh/vàng/đỏ cho từng liên kết | |
| 15 | Debugging | Bảng "Vấn đề → Nguyên nhân → Cách xử lý" (mỗi mảng 1–2 lỗi thật đã gặp) | Cả nhóm |
| 16 | Kiểm thử | Bảng TC01–TC18: Đạt / Một phần / Chưa test (trung thực) | |
| 17 | Demo | Video 1–2 phút: tải ảnh → xem trước → gửi → máy vẽ → web báo hoàn thành | |
| 18 | Khó khăn & kế hoạch W8–W9 | Rủi ro còn lại + việc cụ thể từng người tới W9 | |
| 19 | Q&A | | |

Mẹo: mỗi slide ≤ 6 dòng chữ; ưu tiên hình/ảnh chụp màn hình; chuẩn bị sẵn video demo phòng khi demo trực tiếp lỗi mạng.

---

## B. Nội dung slide phần Web & Server (đã làm xong code)

### Slide 5 — Web & Server: công nghệ và cấu trúc
**Tiêu đề:** IV.1 Hiện thực Web & Server

| Thành phần | Công nghệ | Lý do chọn |
|---|---|---|
| Máy chủ | Node.js 22 + Express | Nhẹ, chạy trên laptop, 1 ngôn ngữ cho web & server |
| Cơ sở dữ liệu | SQLite (`node:sqlite`) | Không cần cài đặt, 1 file, đủ cho vài máy |
| Xử lý ảnh | sharp + thuật toán tự viết | Giải mã PNG/JPG nhanh, xử lý trên server |
| MQTT Broker | Aedes (nhúng trong server) | Không cần cài Mosquitto, tự xác thực bằng token máy |
| Realtime | WebSocket (`ws`) | Đẩy trạng thái tới trình duyệt không cần tải lại |
| Xác thực | JWT + bcrypt | Phân quyền user / admin |
| Giao diện | HTML/CSS/JS thuần | Không cần build, dễ sửa |

Ghi chú nói: server chạy trên máy tính cá nhân; trình duyệt và máy CNC đều kết nối tới máy này qua Wi-Fi/LAN.

### Slide 6 — Converter: ảnh → G-code
**Tiêu đề:** IV.2 Khối Converter – chuyển ảnh thành quỹ đạo vẽ

Sơ đồ pipeline (vẽ thành chuỗi khối ngang):

```
Ảnh PNG/JPG → Ảnh xám → Ngưỡng nhị phân → Làm mảnh Zhang–Suen (đường tâm)
            hoặc Tách biên (đường viền) → Dò nét 8 hướng → Giản lược Ramer–Douglas–Peucker
            → Làm mượt Chaikin → Sắp xếp nét (láng giềng gần nhất) → Kẹp vùng vẽ → G-code
```

- Tham số người dùng chỉnh: kích thước (mm), mức chi tiết 1–10, ngưỡng, kiểu nét, làm mượt, tốc độ, lệnh nâng/hạ bút.
- Sắp xếp nét giảm quãng chạy không (bút nhấc).
- Mọi tọa độ được kẹp trong vùng vẽ của máy đã chọn → đảm bảo TC18.
- Kết quả mẫu: ảnh 400×300 (hình tròn + chữ nhật) → 8 nét, 171 dòng G-code, tổng chiều dài vẽ 417 mm.

Hình: chụp màn hình ảnh gốc cạnh bản xem trước G-code.

### Slide 7 — Hàng đợi & truyền file tới máy
**Tiêu đề:** IV.3 Job Dispatcher – hàng đợi FIFO và truyền file qua MQTT

Máy trạng thái của một phiên vẽ:

```
QUEUED → SENDING → READY → DRAWING ⇄ PAUSED → COMPLETED
                                          ↘ CANCELLED / FAILED
```

- Mỗi máy có hàng đợi FIFO riêng; máy về `IDLE` → server tự gửi phiên kế tiếp.
- File G-code chia gói 2 KB, mỗi gói kèm CRC32; gửi tuần tự QoS 1 (chờ PUBACK) để ESP32 kịp ghi SD.
- Máy kiểm CRC từng gói + toàn file → `FILE_OK` / `FILE_ERROR`. Quá 30 s không phản hồi → phiên `FAILED`.
- Pause / Resume / Cancel kiểm tra theo trạng thái hiện tại (vd: chỉ tạm dừng khi đang vẽ; hủy phiên đang chờ thì xóa khỏi hàng đợi, không cần gửi xuống máy).

### Slide 8 — Giao thức MQTT & giám sát máy
**Tiêu đề:** IV.4 Giao thức truyền thông Server ⇄ Máy

| Topic | Chiều | Nội dung |
|---|---|---|
| `cnc/<id>/cmd` | Server → Máy | START_JOB, PAUSE, RESUME, CANCEL, HOME |
| `cnc/<id>/file` | Server → Máy | Gói G-code (base64 + CRC32) |
| `cnc/<id>/status` | Máy → Server | Trạng thái, tiến độ, sự kiện, nhịp tim 5 s |

- **Bảo mật:** máy đăng nhập broker bằng mã máy + token do Admin cấp; broker chỉ cho máy đọc/ghi đúng topic của mình (TC10).
- **Phát hiện mất kết nối:** LWT (báo ngay khi rớt mạng) + nhịp tim (quá 15 s → OFFLINE) (TC09).
- Máy mất mạng khi đang vẽ vẫn vẽ hết file; sự kiện `JOB_DONE` được lưu và gửi bù khi có mạng lại.

### Slide 9 — Giao diện web
**Tiêu đề:** IV.5 Giao diện web

Chụp 3–4 màn hình: Đăng nhập · Vẽ mới (tải ảnh + xem trước + chọn máy) · Phiên vẽ (thanh tiến độ, nút tạm dừng/tiếp tục/hủy) · Quản trị (máy, token, người dùng, hàng đợi).

| Khối (theo kiến trúc) | Trạng thái |
|---|---|
| Auth View, Image Uploader, G-code Viewer, Machine Selector | Xong |
| Job List, Job Control UI, Notification UI (WebSocket) | Xong |
| Admin Dashboard (máy, token, khóa tài khoản, hàng đợi) | Xong |

### Slide 9b — Kiểm thử Web & Server với máy giả lập
**Tiêu đề:** IV.6 Kết quả kiểm thử phần Web & Server

Đã viết **máy CNC giả lập** (`simulator/sim.js`) nói đúng giao thức MQTT để kiểm thử khi chưa có phần cứng; nó cũng làm "máy thứ hai" cho TC10.

| TC | Nội dung | Kết quả (với máy giả lập) |
|---|---|---|
| TC01 | Đăng nhập sai / đúng, phân quyền | Đạt |
| TC02 | Ảnh → G-code, xem trước | Đạt |
| TC03 | File sai định dạng / quá 5 MB | Đạt (400 / 413) |
| TC04 | Gửi phiên cho máy rảnh | Đạt (FILE_OK → JOB_READY → DRAWING) |
| TC05 | Hàng đợi khi máy bận | Đạt (phiên 2 tự chạy sau phiên 1) |
| TC06 | User gọi API admin | Đạt (403) |
| TC07 | Gói file sai CRC | Đạt (FILE_ERROR, phiên FAILED, web báo lỗi) |
| TC08 | Pause / Resume / Cancel | Đạt |
| TC09 | Mất kết nối | Server phát hiện qua LWT – Đạt; phần "máy vẽ tiếp" chờ firmware |
| TC10 | 2 máy song song | Đạt (2 máy giả lập, topic tách biệt, sai token bị từ chối) |
| TC11 | Thông báo hoàn thành realtime | Đã hiện thực, cần quay video demo |
| TC12 | Khởi động lại máy | Chờ firmware |

> Ghi chú: cột kết quả là với máy giả lập; khi tích hợp ESP32 thật cần chạy lại.

---

## C. Gợi ý slide Debugging cho phần Web/Server
Ghi **lỗi thật** nhóm gặp khi tích hợp. Các vấn đề đã xử lý trong thiết kế:

| Vấn đề | Nguyên nhân | Cách xử lý |
|---|---|---|
| ESP32 có thể không kịp ghi file khi nhận dồn dập | Bộ nhớ RAM nhỏ, ghi SD chậm | Chia gói 2 KB, gửi tuần tự QoS 1, chờ PUBACK mới gửi gói tiếp |
| Mất sự kiện "vẽ xong" khi máy rớt Wi-Fi | Bản tin phát sinh lúc offline | Máy lưu sự kiện, gửi bù khi kết nối lại |
| Phiên đang truyền file thì máy rớt mạng | File nhận dở | Server đưa phiên về lại hàng đợi |
| Máy lạ / máy khác chiếm topic | Broker mở | Xác thực token + ACL theo topic từng máy |
