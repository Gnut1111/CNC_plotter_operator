# Kiểm chứng tìm cấu hình vẽ

## Kế hoạch

1. Dùng bốn ảnh trong `docs/samples` để bao phủ nét đơn, logo, nền tối và ánh sáng không đều. Thêm bướm, mandala, rồng và mạch điện từ bộ ảnh 2D của nhóm để thử chi tiết dày và đường song song.
2. So G-code cũ và mới bằng cùng ảnh tham chiếu 960 px, vùng vẽ tối đa 120 × 80 mm và bút 0,5 mm. Tách độ trùng diện tích mực khỏi độ gần của nét. Theo dõi riêng tỷ lệ mực gốc được phủ đúng và thời gian vẽ ước tính để phát hiện trường hợp mất nét hoặc tăng thời gian quá nhiều.
3. Giữ phương án tốt của bộ tìm cũ làm mốc. Tìm thêm đường tô gạch ngang và dọc có bù bán kính bút, giữ đường tâm ở vùng hẹp và thử độ phân giải dò nét tới 1280 px ở chế độ Chi tiết. Chấm sơ bộ ở 400 px để chọn số ít ứng viên phát lại G-code ở 960 px. Loại ứng viên mất hơn 6 điểm phần trăm mực gốc so với phương án Chi tiết cũ được chấm lại.
4. Kiểm giới hạn thời gian tách riêng trên HTTP và kiểm việc tái tạo cấu hình qua bản xem trước. Chạy kiểm thử lệnh, tọa độ và luồng gửi máy giả lập. Khi có phần cứng, đo bề rộng mực thực, thử bản vẽ nhỏ và đo thời gian chạy cả file dày nét.

## Kết quả mô phỏng

Bản cũ là commit `55674e1`. Cả hai bộ G-code được phát lại bằng cùng mô hình đầu bút. Các tỷ lệ dưới đây là **IoU diện tích mực**, khác với số liệu chấm ở 400 px trước đó.

| Ảnh | Chi tiết cũ | Chi tiết mới | Nhanh cũ | Nhanh mới |
|---|---:|---:|---:|---:|
| Nét đơn | 76,7% | 76,7% | 73,9% | 73,9% |
| Logo | 96,5% | 98,8% | 96,5% | 98,6% |
| Nền tối | 82,4% | 83,2% | 81,3% | 82,7% |
| Ánh sáng không đều | 83,1% | 83,1% | 81,8% | 81,8% |
| Bướm chi tiết | 71,0% | 91,3% | 69,2% | 90,3% |
| Mandala | 52,5% | 52,6% | 46,6% | 52,6% |
| Rồng châu Á | 66,2% | 66,7% | 59,0% | 65,2% |

Ảnh bướm tăng độ trùng chủ yếu nhờ giảm mực lấn. Diện tích mực gốc được phủ đúng giảm từ 97,5% xuống 94,3% và thời gian vẽ ước tính của Chi tiết tăng từ 11,6 lên 17,1 phút. Với mandala, mức trùng diện tích gần như giữ nguyên ở bút 0,5 mm dù đổi tiêu chí chấm. Chi tiết và Nhanh cùng chọn một phương án đạt mức giữ nét yêu cầu.

Ảnh mạch điện được gọi riêng qua HTTP trên Ryzen 7 5800H. Nhanh trả trong khoảng 6,1 giây với IoU 63,0%. Chi tiết trả trong khoảng 11,2 giây với IoU 67,5%. API trạng thái máy vẫn phản hồi trong khoảng 3–4 ms khi worker đang tìm. Các mốc này phụ thuộc máy chạy server, kích thước ảnh và tải cùng lúc.

## Chạy lại

Trong repo, sau khi cài phụ thuộc ở `server/`:

```bash
baseline_dir=$(mktemp -d)
git archive 55674e1 server/src | tar -x -C "$baseline_dir"
ln -s "$PWD/server/node_modules" "$baseline_dir/server/node_modules"
node server/tools/benchmark-tuning.js "$baseline_dir/server/src/converter.js" docs/samples/*.png docs/samples/*.jpg
node --test server/test/*.test.js
```

Thay các đường dẫn ảnh ở lệnh benchmark bằng ảnh bướm, mandala và rồng để đo nhóm ảnh dày. Có thể gọi riêng từng ảnh để đo thời gian của hai profile mà không phụ thuộc thời lượng của cả nhóm. Báo cáo JSON theo từng ảnh gồm IoU, tỷ lệ mực gốc phủ đúng, tỷ lệ mực đầu ra phủ đúng, thời gian tìm, số cấu hình kiểm tra kỹ và số dòng G-code.

Các kết quả chấm ảnh mô tả mực mô phỏng từ G-code. Sai số bước máy, lực tì bút và lan mực phụ thuộc máy và giấy thật.
