# CNC_plotter_operator — Pixel2Plot

Hệ thống máy vẽ CNC hai trục điều khiển qua Wi-Fi: **ảnh → G-code → gửi qua MQTT → máy vẽ**, quản lý nhiều người dùng / nhiều máy trên một giao diện web.

Đồ án môn học — UIT, Khoa KTMT · GVHD: TS. Nguyễn Minh Sơn · Nhóm **Pixel2Plot**.

## Cấu trúc repo

```
server/      Máy chủ Node.js: REST API, Converter ảnh→G-code, Job Dispatcher, MQTT broker nhúng, WebSocket
web/         Giao diện web (HTML/CSS/JS thuần, server phục vụ tĩnh)
simulator/   Máy CNC giả lập qua MQTT — test web/server khi chưa có phần cứng
firmware/    Firmware ESP32 (2 lõi: mạng + điều khiển CNC)
hardware/    Sơ đồ nguyên lý, BOM, bản vẽ cơ khí
docs/        Giao thức MQTT, API, dàn ý báo cáo
```

## Chạy thử (cần Node.js ≥ 22.5)

```bash
# 1. Server (web + API + MQTT broker)
cd server
npm install
npm start                 # http://localhost:3000 , MQTT :1883

# 2. Máy giả lập (terminal khác)
cd simulator
npm install
node sim.js --id sim-01 --token sim-01-token
```

Mở `http://localhost:3000`, đăng nhập:

| Tài khoản | Mật khẩu | Vai trò |
|---|---|---|
| `admin` | `admin123` | Quản trị |
| `user` | `user123` | Người dùng |

Máy có sẵn: `cnc-01` (token `cnc-01-token`, dành cho ESP32 thật) và `sim-01` (token `sim-01-token`, giả lập).
Có thể chạy giả lập với mã `cnc-01` để làm máy thứ hai: `node sim.js --id cnc-01 --token cnc-01-token`.

Phím tắt trong máy giả lập: `e` E-Stop · `l` chạm Limit · `o` rút Wi-Fi · `c` cắm lại · `q` thoát. Thêm `--corrupt` để làm hỏng gói file đầu tiên (TC07), `--speed 20` để vẽ chậm (test pause/resume).

Cho ESP32 kết nối: dùng IP LAN của máy chạy server (vd `mqtt://192.168.1.10:1883`). Nhớ mở firewall cổng 1883 và 3000.
Trên WSL2, cần forward cổng từ Windows hoặc bật mirrored networking.

### Biến môi trường

| Biến | Mặc định |
|---|---|
| `HTTP_PORT` | 3000 |
| `MQTT_PORT` | 1883 |
| `JWT_SECRET` | `dev-secret-change-me` (đổi khi demo) |
| `DATA_DIR` | `server/data` (CSDL SQLite, ảnh, G-code) |

Xóa `server/data/` để reset CSDL về dữ liệu mẫu.

## So sánh chất lượng chuyển đổi (cho báo cáo)

```bash
cd server
node tools/compare.js ../docs/samples/*.png ../docs/samples/*.jpg --out ../docs/img/auto-tune
```
Tạo ảnh so sánh (ảnh gốc | cấu hình cũ | 3 phương án tự động) và bảng `results.md`. Thay bằng ảnh thật của nhóm để có số liệu đưa vào slide.

## Tài liệu
- [Giao thức MQTT Server ⇄ Máy](docs/mqtt-protocol.md) — **nhóm firmware đọc file này**
- [REST API & WebSocket](docs/api.md)
- [Dàn ý báo cáo giữa kì](docs/midterm-slides.md)
- [Quy trình làm việc chung](CONTRIBUTING.md)
