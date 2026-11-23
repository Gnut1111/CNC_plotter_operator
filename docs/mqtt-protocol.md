# Giao thức MQTT giữa Server ⇄ Máy CNC

> Tài liệu "hợp đồng" giữa nhóm **Web/Server** và nhóm **Firmware**. Muốn đổi gì thì sửa file này trước, báo cả nhóm, rồi mới sửa code.
> Bản hiện thực tham chiếu: `simulator/sim.js` (máy giả lập chạy đúng giao thức này).

## 1. Kết nối

| Thuộc tính | Giá trị |
|---|---|
| Broker | `mqtt://<IP máy chạy server>:1883` (broker nhúng trong server) |
| `clientId` | **mã máy**, vd `cnc-01` (phải trùng username) |
| `username` | mã máy, vd `cnc-01` |
| `password` | token máy (Admin cấp ở trang Quản trị) |
| Keep-alive | 30 s |
| LWT (Last Will) | topic `cnc/<id>/status`, payload `{"state":"OFFLINE","event":"LWT"}`, QoS 1 |
| QoS | 1 cho mọi bản tin |

Máy chỉ được **publish** `cnc/<id>/status` và chỉ được **subscribe** `cnc/<id>/cmd`, `cnc/<id>/file` (broker chặn các topic khác).

## 2. Topic

| Topic | Chiều | Nội dung |
|---|---|---|
| `cnc/<id>/cmd` | Server → Máy | Lệnh điều khiển |
| `cnc/<id>/file` | Server → Máy | Các gói file G-code |
| `cnc/<id>/status` | Máy → Server | Trạng thái, sự kiện, nhịp tim |

Mọi payload là **JSON UTF-8**.

## 3. Lệnh (`cnc/<id>/cmd`)

```json
{ "cmd": "START_JOB", "jobId": 12, "size": 48213, "chunks": 24, "crc32": 3735928559 }
{ "cmd": "PAUSE",  "jobId": 12 }
{ "cmd": "RESUME", "jobId": 12 }
{ "cmd": "CANCEL", "jobId": 12 }
{ "cmd": "HOME" }
```

- `START_JOB`: chuẩn bị nhận file. `size` = tổng số byte, `chunks` = số gói, `crc32` = CRC32 của **toàn bộ file**. Nếu máy không ở `IDLE` → trả `FILE_ERROR` với `error: "BUSY"`.
- `PAUSE`: dừng sau dòng hiện tại, **nâng bút**, chuyển `PAUSED`.
- `RESUME`: hạ bút lại (nếu trước đó đang hạ) và vẽ tiếp từ dòng đã dừng.
- `CANCEL`: dừng, nâng bút, xóa file, gửi `CANCELLED`, về `IDLE`.
- `HOME`: chạy về gốc (dùng để thoát trạng thái `ERROR` sau E-Stop / chạm Limit).

## 4. Gói file (`cnc/<id>/file`)

```json
{ "jobId": 12, "seq": 0, "total": 24, "crc32": 123456789, "data": "<base64 tối đa 2048 byte>" }
```

- Gửi tuần tự `seq = 0 … total-1`, QoS 1.
- Máy giải base64, tính CRC32 của gói → so với `crc32`. Sai → gửi `FILE_ERROR`, hủy nhận, về `IDLE`.
- Nếu không nhận đủ gói sau 30 giây, bỏ file dở, gửi sự kiện lỗi kèm mã phiên rồi báo máy rảnh.
- Ghi gói vào SD/Flash. Nhận đủ gói → kiểm tra `size` và CRC32 toàn file.
  - Đúng → gửi `FILE_OK`, rồi `JOB_READY` (state `READY`), rồi **tự bắt đầu vẽ** (state `DRAWING`).
  - Sai → `FILE_ERROR`.
- CRC32 chuẩn IEEE 802.3 (giống `zlib.crc32`, ESP32: `esp_rom_crc32_le(0, buf, len)`), số nguyên **không dấu**.

## 5. Trạng thái (`cnc/<id>/status`)

```json
{ "state": "DRAWING", "jobId": 12, "progress": 42.5, "event": null, "error": null, "ts": 1732250000000 }
```

`state` ∈ `BOOT | HOMING | IDLE | RECEIVING | READY | DRAWING | PAUSED | ERROR | OFFLINE`. Nếu firmware có xác nhận giấy tại máy, có thể báo `WAIT_PAPER` trong lúc chờ.

`event` (tùy chọn):

| event | Khi nào | Server xử lý |
|---|---|---|
| `HEARTBEAT` | mỗi **5 s** | cập nhật `last_seen`. Quá 15 s không nhận → máy OFFLINE |
| `READY` | khởi động xong, đã về gốc | máy sẵn sàng nhận phiên |
| `FILE_OK` | file nhận đủ và đúng CRC | ghi log |
| `FILE_ERROR` | gói sai CRC / thiếu gói / máy bận | phiên → `FAILED`, báo web |
| `JOB_READY` | sẵn sàng vẽ | phiên → `READY` |
| `JOB_DONE` | vẽ xong | phiên → `COMPLETED`, web nhận `job.completed` |
| `CANCELLED` | đã hủy theo lệnh | phiên → `CANCELLED` |
| `ERROR` | E-Stop, chạm Limit… (kèm `error`) | phiên → `FAILED`, máy → `ERROR` |
| `RECONNECTED` | có mạng lại sau khi rớt | cập nhật trạng thái |

- Khi `DRAWING`, gửi `progress` (0–100) mỗi khi tăng ≥ 2 %.
- Mỗi khi `state` đổi phải gửi một bản tin.
- Khi máy rảnh, gửi rõ `"jobId": null` trong bản tin `IDLE`. Sau một phiên, phát sự kiện kết thúc kèm mã phiên trước khi báo `IDLE`.
- Khi có mạng lại, gửi bù sự kiện kết thúc trước bản tin trạng thái đồng bộ. Nếu khởi động lại và mất file đang chạy, báo `IDLE` với `jobId: null` và sự kiện `READY`. Server đánh dấu phiên bị gián đoạn và chờ quản trị viên xác nhận đã kiểm tra giấy trước khi giao việc tiếp.
- Khi mất mạng giữa một lượt, lệnh Hủy đợi máy kết nối lại. ESP chỉ phát `CANCELLED` sau khi đã dừng và nâng bút. Server chỉ xác nhận hủy khi nhận được sự kiện này kèm đúng mã phiên.
- Mất Wi-Fi khi đang vẽ: **vẽ tiếp từ file cục bộ**; các sự kiện phát sinh (vd `JOB_DONE`) được **lưu lại và gửi bù** khi kết nối lại.

## 6. Luồng chuẩn

```
Server                                   Máy
  │ cmd  START_JOB {jobId,size,chunks,crc}│
  │──────────────────────────────────────▶│ state RECEIVING
  │ file seq 0..N-1                       │
  │──────────────────────────────────────▶│ kiểm CRC từng gói, ghi SD
  │            status event FILE_OK       │
  │◀──────────────────────────────────────│
  │   status state READY, event JOB_READY │
  │◀──────────────────────────────────────│
  │   status state DRAWING, progress …    │
  │◀──────────────────────────────────────│
  │            status event JOB_DONE      │
  │◀──────────────────────────────────────│
  │            status state IDLE          │ → server gửi phiên kế tiếp
  │◀──────────────────────────────────────│
```

## 7. G-code máy cần hiểu

`G21` chọn mm, `G90` chọn tọa độ tuyệt đối. `G0 Z5` nâng bút, `G1 Z0 F300` hạ bút. `G0 X… Y…` chạy không theo rapid của firmware. `G1 X… Y… F900` vẽ. Phiên kết thúc bằng nâng bút, `G0 X0 Y0` rồi `M2`. Dòng bắt đầu bằng `;` là chú thích. Xem [cấu hình máy HTrang](machine-profile.md).
