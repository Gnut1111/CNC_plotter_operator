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
DEMO_MODE=true npm start  # http://127.0.0.1:3000, MQTT 127.0.0.1:1883

# 2. Máy giả lập (terminal khác)
cd simulator
npm install
node sim.js --id sim-01 --token sim-01-token
```

Mở `http://127.0.0.1:3000` trên máy chạy server. Tài khoản mặc định chỉ dùng trong chế độ demo cục bộ.

| Tài khoản | Mật khẩu | Vai trò |
|---|---|---|
| `admin` | `admin123` | Quản trị |
| `user` | `user123` | Người dùng |

Máy có sẵn: `cnc-01` (token `cnc-01-token`, dành cho ESP32 thật) và `sim-01` (token `sim-01-token`, giả lập).
Có thể chạy giả lập với mã `cnc-01` để làm máy thứ hai: `node sim.js --id cnc-01 --token cnc-01-token`.

Phím tắt trong máy giả lập: `e` E-Stop · `l` chạm Limit · `o` rút Wi-Fi · `c` cắm lại · `q` thoát. Thêm `--corrupt` để làm hỏng gói file đầu tiên (TC07), `--speed 20` để vẽ chậm (test pause/resume).

### Triển khai cho nhóm

- Chạy server với `DEMO_MODE` tắt. Lần đầu, đặt `ADMIN_PASSWORD` qua môi trường của dịch vụ. Mật khẩu cần từ 12 ký tự và tối đa 72 byte.
- Nếu dùng lại SQLite từ bản cũ, server yêu cầu `ADMIN_PASSWORD` mới khi mật khẩu admin vẫn là mặc định. Tài khoản user dùng mật khẩu mẫu sẽ bị khóa. Admin có thể đặt lại mật khẩu rồi mở khóa. Token MQTT mặc định của hai máy mẫu sẽ được thay tự động. Lấy token mới trong **Quản trị → Máy CNC**.
- Mỗi người có một tài khoản riêng. Một tài khoản mở được nhiều tab trên cùng trình duyệt và chỉ có một phiên hoạt động. Phiên hết hạn sau 30 phút không có yêu cầu API hoặc sau 8 giờ. Admin có thể thu hồi phiên từ trang Quản trị.
- Đặt HTTPS ở reverse proxy trên cùng máy với backend. Giữ cổng HTTP nội bộ ở loopback và cấu hình proxy chuyển đúng `Host`, `X-Forwarded-Proto` và địa chỉ IP thực của khách. Proxy phải ghi đè các header chuyển tiếp do khách gửi.
- ESP32 kết nối qua MQTT trên mạng nội bộ. Đặt `MQTT_HOST=0.0.0.0` nếu cần kết nối từ ESP32 và giới hạn cổng MQTT bằng firewall cho mạng thiết bị. Broker nhúng dùng TCP thường. Dùng broker MQTT có TLS nếu kết nối đi qua mạng không tin cậy. Với broker ngoài, quản lý quyền kết nối và token thiết bị tại broker.

| Biến | Mặc định |
|---|---|
| `HTTP_HOST`, `HTTP_PORT` | `127.0.0.1`, `3000` |
| `MQTT_HOST`, `MQTT_PORT` | `127.0.0.1`, `1883` |
| `ADMIN_PASSWORD` | Dùng khi khởi tạo hoặc khi thay mật khẩu admin mặc định trong CSDL cũ |
| `DEMO_MODE` | Tắt |
| `DATA_DIR` | `server/data`, chứa SQLite, ảnh và G-code |
| `EMBEDDED_BROKER`, `MQTT_URL`, `SERVER_MQTT_PASS` | Broker nhúng bật. Khi dùng broker ngoài, cấu hình URL và mật khẩu kết nối nội bộ. |

### Đăng ký tài khoản

Người dùng chọn **Đăng ký** để tạo tài khoản bằng tên đăng nhập và mật khẩu. Tài khoản tự đăng ký có vai trò `user` và có thể gửi bản vẽ. Phiên đang hoạt động trên thiết bị khác được giữ nguyên nếu có lần đăng nhập trùng.

Để bật **Tiếp tục với Google**, tạo OAuth client loại **Web application** trong [Google Cloud Console](https://console.cloud.google.com/auth/clients). Đăng ký chính xác URL callback, ví dụ `http://127.0.0.1:3003/api/auth/google/callback` khi thử cục bộ. Khi triển khai, dùng cùng đường dẫn trên tên miền HTTPS của web. Đặt ba biến môi trường sau trong dịch vụ máy chủ rồi khởi động lại.

| Biến | Giá trị |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID của OAuth client |
| `GOOGLE_CLIENT_SECRET` | Client secret, chỉ lưu ở máy chủ |
| `GOOGLE_REDIRECT_URI` | URL callback đã khai báo trong Google Cloud |

Nút Google chỉ hoạt động ở địa chỉ tương ứng với callback. Nếu ứng dụng Google ở chế độ Testing, thêm tài khoản cần thử vào danh sách test users. Lần đầu dùng Google, server tạo một tài khoản `user` riêng. Server nhận ra người dùng quay lại bằng định danh Google, kể cả khi địa chỉ email hiển thị của họ thay đổi.

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
