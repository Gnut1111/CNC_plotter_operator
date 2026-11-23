#!/usr/bin/env node
// So sánh trước/sau cho báo cáo: ảnh gốc | cấu hình mặc định | 2 phương án tự động
//   node tools/compare.js <ảnh1> [ảnh2 ...] --out <thư mục>
// Kết quả: <tên>-compare.png cho từng ảnh + results.md (bảng số liệu)
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { convert, autoTune } = require("../src/converter");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : "compare-out";
const files = args.filter((a, i) => a !== "--out" && i !== outIdx + 1);
if (!files.length) { console.log("Cách dùng: node tools/compare.js <ảnh...> --out <thư mục>"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const WORK = { width: 200, height: 200 };
const CELL = 360, PAD = 12, HEAD = 56;

// Vẽ G-code ra SVG (chỉ nét bút hạ), khung = vùng bản vẽ
function gcodeSvg(gcode, params, bbox) {
  const [x0, y0, x1, y1] = bbox;
  const k = (CELL - 2 * PAD) / Math.max(x1 - x0, y1 - y0);
  const X = (x) => PAD + (x - x0) * k, Y = (y) => PAD + (y1 - y) * k;
  let down = false, x = 0, y = 0, d = "";
  for (const line of gcode.split("\n")) {
    if (line === params.penUp) { down = false; continue; }
    if (line === params.penDown) { down = true; d += `M${X(x).toFixed(1)} ${Y(y).toFixed(1)}`; continue; }
    const m = line.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/);
    if (!m) continue;
    x = +m[2]; y = +m[3];
    if (m[1] === "1" && down) d += `L${X(x).toFixed(1)} ${Y(y).toFixed(1)}`;
  }
  const w = Math.max(0.6, params.penWidthMm * k);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}"><rect width="100%" height="100%" fill="white"/>
    <path d="${d}" fill="none" stroke="#1d2330" stroke-width="${w.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const MODE = { centerline: "Đường tâm", outline: "Đường viền", fill: "Viền + tô gạch" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

(async () => {
  const rows = [];
  for (const file of files) {
    const buf = fs.readFileSync(file);
    const name = path.basename(file).replace(/\.[^.]+$/, "");
    const auto = await autoTune(buf, {}, WORK);
    // Mọi cột được chấm trên cùng ảnh tham chiếu (tách nét tự động)
    const ref = auto.reference;
    const refParams = { threshold: ref.method === "adaptive" ? "adaptive" : ref.level, invert: ref.invert, despeckle: true };
    const def = await convert(buf, { threshold: 128, invert: false, mode: "centerline" }, WORK, { refParams }); // như bản cũ: ngưỡng cố định 128
    const cols = [{ title: "Ảnh gốc", sub: "" }];
    cols.push({ title: "Mặc định (cũ)", sub: `lệch ${def.stats.chamferMm} mm · ${def.stats.iou}% · ${def.stats.minutes} ph`, gcode: def.gcode, params: def.params, bbox: def.stats.bbox });
    rows.push({ name, label: "Mặc định (cũ)", mode: "Đường tâm, ngưỡng 128", ...def.stats });
    for (const c of auto.candidates) {
      const r = await convert(buf, c.params, WORK, { refParams });
      cols.push({ title: c.label, sub: `lệch ${r.stats.chamferMm} mm · ${r.stats.iou}% · ${r.stats.minutes} ph`, gcode: r.gcode, params: r.params, bbox: r.stats.bbox });
      rows.push({ name, label: c.label, mode: `${MODE[c.params.mode]}, chi tiết ${c.params.detail}`, ...r.stats });
    }

    const layers = [];
    for (const [i, c] of cols.entries()) {
      const left = i * CELL;
      const tile = c.gcode
        ? await sharp(Buffer.from(gcodeSvg(c.gcode, c.params, c.bbox))).png().toBuffer()
        : await sharp(buf).resize(CELL - 2 * PAD, CELL - 2 * PAD, { fit: "contain", background: "#fff" }).extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: "#fff" }).png().toBuffer();
      layers.push({ input: tile, left, top: HEAD });
      layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${HEAD}">
        <text x="${CELL / 2}" y="24" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="bold" fill="#1d2330">${esc(c.title)}</text>
        <text x="${CELL / 2}" y="46" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#6b7385">${esc(c.sub)}</text></svg>`), left, top: 0 });
    }
    const out = path.join(outDir, `${name}-compare.png`);
    await sharp({ create: { width: CELL * cols.length, height: CELL + HEAD, channels: 3, background: "#ffffff" } })
      .composite(layers).png().toFile(out);
    console.log("→", out);
  }

  const md = ["| Ảnh | Cấu hình | Kiểu nét | Lệch TB (mm) | Trùng khớp | Thời gian (phút) | Số nét |", "|---|---|---|---|---|---|---|"]
    .concat(rows.map((r) => `| ${r.name} | ${r.label} | ${r.mode} | ${r.chamferMm} | ${r.iou}% | ${r.minutes} | ${r.paths} |`));
  fs.writeFileSync(path.join(outDir, "results.md"), md.join("\n") + "\n");
  console.log("→", path.join(outDir, "results.md"));
})();
