// Converter: ảnh PNG/JPG → đường nét → G-code
// Thuật toán port từ bản web tĩnh cũ (repo CNC_Ploter/app.js), chạy trên server bằng sharp.
const sharp = require("sharp");

const DEFAULTS = {
  widthMm: 150, // kích thước bản vẽ mong muốn (giữ tỉ lệ ảnh)
  heightMm: 150,
  detail: 5, // 1..10 — cao hơn = độ phân giải xử lý cao hơn, ít đơn giản hóa hơn
  threshold: 128, // 0..255 — ngưỡng tách nét đen
  invert: false,
  mode: "centerline", // "centerline" (làm mảnh nét) | "outline" (đường viền)
  smoothing: 1, // 0..3 vòng làm mượt Chaikin
  travelFeed: 3000, // mm/phút
  drawFeed: 1500,
  penUp: "M5", // servo nâng bút
  penDown: "M3 S90", // servo hạ bút
};

function normalizeParams(input = {}, workArea) {
  const p = { ...DEFAULTS };
  const num = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  p.widthMm = num(input.widthMm, 10, workArea.width, Math.min(DEFAULTS.widthMm, workArea.width));
  p.heightMm = num(input.heightMm, 10, workArea.height, Math.min(DEFAULTS.heightMm, workArea.height));
  p.detail = Math.round(num(input.detail, 1, 10, DEFAULTS.detail));
  p.threshold = Math.round(num(input.threshold, 1, 254, DEFAULTS.threshold));
  p.invert = input.invert === true || input.invert === "true";
  p.mode = input.mode === "outline" ? "outline" : "centerline";
  p.smoothing = Math.round(num(input.smoothing, 0, 3, DEFAULTS.smoothing));
  p.travelFeed = num(input.travelFeed, 100, 10000, DEFAULTS.travelFeed);
  p.drawFeed = num(input.drawFeed, 100, 10000, DEFAULTS.drawFeed);
  if (typeof input.penUp === "string" && /^[A-Z0-9 .\-]{1,20}$/i.test(input.penUp)) p.penUp = input.penUp;
  if (typeof input.penDown === "string" && /^[A-Z0-9 .\-]{1,20}$/i.test(input.penDown)) p.penDown = input.penDown;
  return p;
}

async function loadGray(buffer, maxSize) {
  const { data, info } = await sharp(buffer)
    .flatten({ background: "#ffffff" })
    .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function threshold(gray, level, invert) {
  const { data, width, height } = gray;
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < binary.length; i++) {
    const dark = data[i] < level;
    binary[i] = invert ? Number(!dark) : Number(dark);
  }
  // Bỏ viền 1px để thuật toán lân cận không tràn biên
  for (let x = 0; x < width; x++) binary[x] = binary[(height - 1) * width + x] = 0;
  for (let y = 0; y < height; y++) binary[y * width] = binary[y * width + width - 1] = 0;
  return { binary, width, height };
}

// Làm mảnh Zhang–Suen → nét 1 pixel (đường tâm)
function thin({ binary, width, height }) {
  const px = new Uint8Array(binary);
  const at = (x, y) => px[y * width + x];
  let changed = true;
  let iter = 0;
  while (changed && iter++ < 80) {
    changed = false;
    for (const pass of [0, 1]) {
      const del = [];
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          if (!at(x, y)) continue;
          const n = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1),
            at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
          const [p2, , p4, , p6, , p8] = n;
          const count = n.reduce((s, v) => s + v, 0);
          if (count < 2 || count > 6) continue;
          let trans = 0;
          for (let i = 0; i < 8; i++) if (!n[i] && n[(i + 1) % 8]) trans++;
          if (trans !== 1) continue;
          const ok = pass === 0 ? !(p2 && p4 && p6) && !(p4 && p6 && p8) : !(p2 && p4 && p8) && !(p2 && p6 && p8);
          if (ok) del.push(y * width + x);
        }
      }
      for (const i of del) px[i] = 0;
      if (del.length) changed = true;
    }
  }
  return { binary: px, width, height };
}

function edges({ binary, width, height }) {
  const out = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (binary[i] && (!binary[i - 1] || !binary[i + 1] || !binary[i - width] || !binary[i + width])) out[i] = 1;
    }
  }
  return { binary: out, width, height };
}

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function trace({ binary, width, height }) {
  const visited = new Uint8Array(width * height);
  const paths = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!binary[start] || visited[start]) continue;
      const path = [];
      let cx = x, cy = y;
      visited[start] = 1;
      for (;;) {
        path.push({ x: cx, y: cy });
        let next = null;
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const i = ny * width + nx;
          if (binary[i] && !visited[i]) { next = [nx, ny]; break; }
        }
        if (!next) break;
        [cx, cy] = next;
        visited[cy * width + cx] = 1;
      }
      if (path.length > 3) paths.push(path);
    }
  }
  return paths;
}

// Ramer–Douglas–Peucker
function simplify(points, tol) {
  if (points.length <= 2 || tol <= 0) return points;
  const sq = tol * tol;
  const segDist = (p, a, b) => {
    let x = a.x, y = a.y, dx = b.x - x, dy = b.y - y;
    if (dx || dy) {
      const t = Math.max(0, Math.min(1, ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy)));
      x += dx * t; y += dy * t;
    }
    return (p.x - x) ** 2 + (p.y - y) ** 2;
  };
  const out = [points[0]];
  const rec = (s, e) => {
    let max = sq, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx > -1) { rec(s, idx); out.push(points[idx]); rec(idx, e); }
  };
  rec(0, points.length - 1);
  out.push(points[points.length - 1]);
  return out;
}

function chaikin(points, iterations) {
  let pts = points;
  for (let k = 0; k < iterations && pts.length >= 3; k++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

function length(points) {
  let t = 0;
  for (let i = 1; i < points.length; i++) t += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return t;
}

// Sắp xếp nét theo láng giềng gần nhất để giảm quãng chạy không
function order(paths) {
  const rest = [...paths];
  const out = [];
  let cur = { x: 0, y: 0 };
  while (rest.length) {
    let best = 0, rev = false, bestD = Infinity;
    rest.forEach((p, i) => {
      const a = p[0], b = p[p.length - 1];
      const da = Math.hypot(a.x - cur.x, a.y - cur.y);
      const db = Math.hypot(b.x - cur.x, b.y - cur.y);
      if (da < bestD) { bestD = da; best = i; rev = false; }
      if (db < bestD) { bestD = db; best = i; rev = true; }
    });
    const [p] = rest.splice(best, 1);
    if (rev) p.reverse();
    out.push(p);
    cur = p[p.length - 1];
  }
  return out;
}

const f = (v) => (Math.round(v * 1000) / 1000).toString();

function toGcode(paths, p) {
  const lines = ["; Pixel2Plot - CNC_plotter_operator", "G21", "G90", p.penUp, `G0 F${p.travelFeed}`];
  for (const path of paths) {
    const [s, ...rest] = path;
    lines.push(`G0 X${f(s.x)} Y${f(s.y)}`);
    lines.push(p.penDown);
    for (const q of rest) lines.push(`G1 X${f(q.x)} Y${f(q.y)} F${p.drawFeed}`);
    lines.push(p.penUp);
  }
  lines.push("G0 X0 Y0", "M2");
  return lines.join("\n") + "\n";
}

/**
 * @param {Buffer} buffer ảnh PNG/JPG
 * @param {object} input tham số người dùng
 * @param {{width:number,height:number}} workArea vùng vẽ của máy (mm)
 */
async function convert(buffer, input, workArea) {
  const p = normalizeParams(input, workArea);
  const maxSize = 150 + p.detail * 60; // 210..750 px
  const gray = await loadGray(buffer, maxSize);
  let bin = threshold(gray, p.threshold, p.invert);
  bin = p.mode === "centerline" ? thin(bin) : edges(bin);
  const pixelPaths = trace(bin);

  // Ánh xạ pixel → mm, giữ tỉ lệ, căn giữa trong vùng widthMm × heightMm, trục Y hướng lên
  const scale = Math.min(p.widthMm / gray.width, p.heightMm / gray.height);
  const offX = (workArea.width - gray.width * scale) / 2;
  const offY = (workArea.height - gray.height * scale) / 2;
  const tol = (11 - p.detail) * 0.05; // mm
  let paths = pixelPaths
    .map((pts) => pts.map((q) => ({ x: offX + q.x * scale, y: offY + (gray.height - q.y) * scale })))
    .map((pts) => chaikin(simplify(pts, tol), p.smoothing))
    .filter((pts) => pts.length > 1 && length(pts) >= 0.5);
  paths = order(paths);

  // Kẹp vào vùng vẽ (TC18: không trục nào vượt giới hạn)
  for (const pts of paths) for (const q of pts) {
    q.x = Math.min(workArea.width, Math.max(0, q.x));
    q.y = Math.min(workArea.height, Math.max(0, q.y));
  }

  const gcode = toGcode(paths, p);
  const stats = {
    paths: paths.length,
    lines: gcode.split("\n").length - 1,
    drawLengthMm: Math.round(paths.reduce((s, pts) => s + length(pts), 0)),
    imageSize: [gray.width, gray.height],
    bbox: [offX, offY, offX + gray.width * scale, offY + gray.height * scale].map((v) => Math.round(v * 10) / 10),
  };
  return { gcode, params: p, stats };
}

module.exports = { convert, normalizeParams, DEFAULTS };
