# Quy trình làm việc chung

## Phân vùng thư mục
| Thư mục | Phụ trách |
|---|---|
| `server/`, `web/`, `simulator/` | Nhóm Web/Server |
| `firmware/` | Nhóm Firmware |
| `hardware/` | Nhóm Phần cứng |
| `docs/` | Cả nhóm |

## Nhánh (branch)
- `main`: luôn chạy được. **Không push thẳng** vào `main`.
- Mỗi việc một nhánh: `feat/<tên-ngắn>`, `fix/<tên-ngắn>`, `docs/<tên-ngắn>` (vd `feat/gcode-parser`).

```bash
git checkout main && git pull
git checkout -b feat/gcode-parser
# ... code ...
git add <file> && git commit -m "firmware: parse G0/G1"
git push -u origin feat/gcode-parser
# Lên GitHub tạo Pull Request vào main, nhờ 1 người review rồi merge
```

## Commit message
`<khu vực>: <việc đã làm>` — vd `server: thêm API khóa tài khoản`, `hw: sơ đồ nguồn 12V`.

## Thay đổi giao thức
Mọi thay đổi bản tin MQTT phải sửa `docs/mqtt-protocol.md` **trong cùng Pull Request** và báo cả nhóm.

## Không commit
File build, `node_modules/`, `server/data/`, mật khẩu Wi-Fi / token thật (để trong `firmware/**/secrets.h`, đã có trong `.gitignore`).
