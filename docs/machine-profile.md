# Cấu hình máy HTrang

Cấu hình trong server lấy từ `CNC_Ploter` commit `22c58c2`. [Repo gốc](https://github.com/htrangvivudaydo/CNC_Ploter/tree/22c58c2)

| Hạng mục | Nguồn | Cách dùng |
|---|---|---|
| Vùng 120 × 80 mm | Mặc định trong `index.html` | Giới hạn xuất G-code. Có thể khai báo vùng nhỏ hơn trong quản trị. Repo gốc chưa có phép đo hành trình hay soft limit xác nhận kích thước vật lý. |
| 80 bước/mm X, 79 bước/mm Y | `pico_cnc.ino` | Bộ tạo G-code bỏ điểm liên tiếp trùng bước. Firmware mới dùng các giá trị này làm mốc khi giữ nguyên driver và chế độ microstep. |
| Hai trục đảo tín hiệu DIR | `INVERT_X` và `INVERT_Y` trong Pico | Phần mềm giữ hệ tọa độ nguyên bản. Firmware mới ánh xạ DIR theo cách đi dây. |
| Tốc độ vẽ 900 mm/phút | Mặc định trong `index.html` | Xuất `G1 X… Y… F900`. |
| Rapid 150 mm/giây, gia tốc 400 mm/giây² | `pico_cnc.ino` | `G0` dùng rapid của firmware. Web HTrang có ô 2400 mm/phút, nhưng Pico dùng `MAX_SPEED_MM_S` cho `G0` bất kể `F`. |
| Nâng 50°, hạ 105°, đổi góc 8 ms/độ, chờ thêm 120 ms | `pico_cnc.ino` | Dùng `G0 Z5` / `G1 Z0 F300` như web cũ. Giá trị Z chọn vị trí servo, firmware không coi đây là hành trình cơ khí 5 mm. |
| Dòng lệnh 96 byte | `MAX_LINE_LEN` trong Pico | Kiểm tra trước khi đưa G-code vào hàng đợi. |

Bề rộng mực là tham số mô phỏng. HTrang chưa ghi số đo, nên 0,5 mm chỉ là giá trị khởi tạo. Mã máy chủ giữ cấu hình này khi tối ưu ảnh. Phiên đã tạo bằng lệnh bút cũ hoặc ngoài vùng máy cần tạo lại từ ảnh đầu vào. Phiên đang chờ được kiểm lại trước khi phát MQTT.

Hai kiến trúc dùng chung ý nghĩa G-code. ESP32 + Pico cũ nhận file qua HTTP `/gcode`, lưu SPIFFS và gửi từng dòng qua UART. Với kiến trúc một ESP32, board nhận file qua MQTT, báo tiến độ và thực thi chuyển động trực tiếp. ESP32 cần điều phối việc phát xung STEP/DIR, chờ servo, giới hạn hành trình và dừng tại máy độc lập với luồng mạng. Phép hiệu chuẩn, chiều chạy và thời gian thực vẫn cần kiểm tại máy.
