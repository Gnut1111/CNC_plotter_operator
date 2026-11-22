# Firmware ESP32

Firmware cho máy vẽ (ESP32 hai lõi, FreeRTOS):

- **Lõi 0 – Mạng & lưu trữ:** Wi-Fi, MQTT client (LWT, nhịp tim 5 s), nhận gói file + kiểm CRC32, ghi SD/Flash, Status Reporter.
- **Lõi 1 – Điều khiển CNC:** parser G-code (`G0/G1/G21/G90/M3/M5/M2`), nội suy, phát xung STEP/DIR, servo bút, Limit X/Y, E-Stop.
- Hai lõi trao đổi qua RTOS Queue.

**Giao thức với server:** xem [`docs/mqtt-protocol.md`](../docs/mqtt-protocol.md). Có thể đọc `simulator/sim.js` làm mẫu hành vi.

Code tham khảo từ repo cũ (CNC_Ploter) đặt trong `legacy/`: `esp32_plotter.ino`, `pico_cnc.ino`.

Đặt thông tin Wi-Fi / token vào `secrets.h` (không commit):

```cpp
#define WIFI_SSID   "..."
#define WIFI_PASS   "..."
#define MQTT_HOST   "192.168.1.10"
#define MACHINE_ID  "cnc-01"
#define MACHINE_TOKEN "cnc-01-token"
```
