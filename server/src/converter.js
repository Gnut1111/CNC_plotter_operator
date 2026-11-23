// Converter: ảnh PNG/JPG → đường nét → G-code
// Thuật toán gốc port từ bản web tĩnh cũ (repo CNC_Ploter/app.js), chạy trên server bằng sharp.
// Bổ sung: ngưỡng tự động (Otsu / thích nghi), tự đảo màu, xóa đốm nhiễu, tô gạch (fill),
// chấm điểm độ giống ảnh gốc (Chamfer, IoU) và tự dò bộ tham số tốt nhất (autoTune).
const sharp = require("sharp");
const { traceSkeleton } = require("./trace-paths");

const DEFAULTS = {
  widthMm: 150, // kích thước bản vẽ mong muốn (giữ tỉ lệ ảnh)
  heightMm: 150,
  detail: 5, // 1..10 — cao hơn = độ phân giải xử lý cao hơn, ít đơn giản hóa hơn
  threshold: "auto", // "auto" | "adaptive" | số 1..254
  invert: "auto", // "auto" | true | false
  mode: "centerline", // "centerline" (đường tâm) | "outline" (đường viền) | "fill" (viền + tô gạch)
  smoothing: 1, // 0..3 vòng làm mượt Chaikin
  despeckle: true, // xóa đốm nhiễu nhỏ
  penWidthMm: 0.5, // bề rộng nét bút — dùng cho khoảng cách tô gạch và chấm điểm
  travelFeed: 3000, // mm/phút
  drawFeed: 1500,
  penUp: "M5", // servo nâng bút
  penDown: "M3 S90", // servo hạ bút
};

const PEN_LIFT_SECONDS = 0.4; // thời gian ước lượng cho mỗi lần nhấc/hạ bút
const EVAL_SIZE = 400; // độ phân giải ảnh tham chiếu khi chấm điểm

function normalizeParams(input = {}, workArea) {
  const p = { ...DEFAULTS };
  const num = (v, min, max, def) => {
    const n = Number(v);
    return v !== "" && v !== null && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  p.widthMm = num(input.widthMm, 10, workArea.width, Math.min(DEFAULTS.widthMm, workArea.width));
  p.heightMm = num(input.heightMm, 10, workArea.height, Math.min(DEFAULTS.heightMm, workArea.height));
  p.detail = Math.round(num(input.detail, 1, 10, DEFAULTS.detail));
  p.threshold = ["auto", "adaptive"].includes(input.threshold)
    ? input.threshold
    : Math.round(num(input.threshold, 1, 254, "auto")) || "auto";
  if (input.invert === true || input.invert === "true") p.invert = true;
  else if (input.invert === false || input.invert === "false") p.invert = false;
  p.mode = ["outline", "fill"].includes(input.mode) ? input.mode : "centerline";
  p.smoothing = Math.round(num(input.smoothing, 0, 3, DEFAULTS.smoothing));
  p.despeckle = !(input.despeckle === false || input.despeckle === "false");
  p.penWidthMm = num(input.penWidthMm, 0.1, 3, DEFAULTS.penWidthMm);
  p.travelFeed = num(input.travelFeed, 100, 10000, DEFAULTS.travelFeed);
  p.drawFeed = num(input.drawFeed, 100, 10000, DEFAULTS.drawFeed);
  if (typeof input.penUp === "string" && /^[A-Z0-9 .\-]{1,20}$/i.test(input.penUp)) p.penUp = input.penUp;
  if (typeof input.penDown === "string" && /^[A-Z0-9 .\-]{1,20}$/i.test(input.penDown)) p.penDown = input.penDown;
  return p;
}

const maxSizeFor = (detail) => 150 + detail * 60; // 210..750 px

async function loadGray(buffer, maxSize) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// ---------------- Tách nét (nhị phân hóa) ----------------

// Otsu: chọn ngưỡng làm cực đại phương sai giữa hai lớp (nét / nền)
function otsu({ data }) {
  const hist = new Array(256).fill(0);
  for (const v of data) hist[v]++;
  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, level = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; level = t + 1; }
  }
  return Math.min(254, Math.max(1, level));
}

// Ánh sáng không đều (ảnh chụp): độ sáng nền giữa các vùng 4×4 chênh nhau nhiều
function unevenLighting({ data, width, height }, level) {
  const means = [];
  for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
    let s = 0, n = 0, all = 0;
    for (let y = Math.floor((by * height) / 4); y < Math.floor(((by + 1) * height) / 4); y++) {
      for (let x = Math.floor((bx * width) / 4); x < Math.floor(((bx + 1) * width) / 4); x++) {
        const v = data[y * width + x];
        all++;
        if (v >= level) { s += v; n++; }
      }
    }
    if (n > all * 0.1) means.push(s / n);
  }
  return means.length >= 4 && Math.max(...means) - Math.min(...means) > 50;
}

function clearBorder(binary, width, height) {
  for (let x = 0; x < width; x++) binary[x] = binary[(height - 1) * width + x] = 0;
  for (let y = 0; y < height; y++) binary[y * width] = binary[y * width + width - 1] = 0;
}

function thresholdFixed(gray, level, invert) {
  const { data, width, height } = gray;
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < binary.length; i++) binary[i] = Number((data[i] < level) !== invert);
  clearBorder(binary, width, height);
  return { binary, width, height };
}

// Ngưỡng thích nghi: so mỗi điểm với trung bình cục bộ (ảnh tích phân)
function thresholdAdaptive(gray, invert, C = 8) {
  const { data, width, height } = gray;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += data[y * width + x];
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row;
    }
  }
  const r = Math.max(3, Math.round(Math.max(width, height) / 24));
  const binary = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1);
      const s = integral[y1 * (width + 1) + x1] - integral[y0 * (width + 1) + x1]
        - integral[y1 * (width + 1) + x0] + integral[y0 * (width + 1) + x0];
      const mean = s / ((x1 - x0) * (y1 - y0));
      const v = data[y * width + x];
      binary[y * width + x] = Number(invert ? v > mean + C : v < mean - C);
    }
  }
  clearBorder(binary, width, height);
  return { binary, width, height };
}

const inkRatio = ({ binary }) => binary.reduce((s, v) => s + v, 0) / binary.length;

/** Nhị phân hóa theo tham số; giải quyết các giá trị "auto". Trả về ảnh nhị phân + cách đã chọn. */
function binarize(gray, p) {
  let method, level = null;
  if (typeof p.threshold === "number") { method = "fixed"; level = p.threshold; }
  else if (p.threshold === "adaptive") method = "adaptive";
  else { level = otsu(gray); method = unevenLighting(gray, level) ? "adaptive" : "otsu"; }
  const make = (inv) => (method === "adaptive" ? thresholdAdaptive(gray, inv) : thresholdFixed(gray, level, inv));
  let invert = p.invert;
  let bin;
  if (invert === "auto") {
    bin = make(false);
    invert = inkRatio(bin) > 0.5; // phần "nét" chiếm quá nửa ảnh → thực ra là nền tối
    if (invert) bin = make(true);
  } else bin = make(invert);
  return { bin, info: { method, level, invert } };
}

// Xóa các cụm điểm (8 lân cận) có diện tích nhỏ hơn minArea
function despeckle({ binary, width, height }, minArea) {
  const out = new Uint8Array(binary);
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || seen[i]) continue;
    let top = 0, n = 0;
    const comp = [];
    stack[top++] = i; seen[i] = 1;
    while (top) {
      const c = stack[--top];
      comp.push(c); n++;
      const cx = c % width, cy = (c - cx) / width;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (out[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    if (n < minArea) for (const c of comp) out[c] = 0;
  }
  return { binary: out, width, height };
}

const minAreaFor = (w, h) => Math.max(4, Math.round(w * h * 0.00003));

// ---------------- Trích đường nét ----------------

// Làm mảnh Zhang–Suen → nét 1 pixel (đường tâm)
const deletionRules = Uint8Array.from({ length: 256 }, (_, mask) => {
  const neighbors = Array.from({ length: 8 }, (_, i) => (mask >> i) & 1);
  const count = neighbors.reduce((sum, value) => sum + value, 0);
  if (count < 2 || count > 6) return 0;
  const transitions = neighbors.filter((value, i) => !value && neighbors[(i + 1) % 8]).length;
  if (transitions !== 1) return 0;

  const [north, , east, , south, , west] = neighbors;
  const first = !(north && east && south) && !(east && south && west);
  const second = !(north && east && west) && !(north && south && west);
  return Number(first) | (Number(second) << 1);
});

function thin(image) {
  // Pad the image so thinning can read all eight neighbors at the frame.
  const stride = image.width + 2;
  const pixels = new Uint8Array(stride * (image.height + 2));
  for (let row = 0; row < image.height; row += 1) {
    const rasterStart = row * image.width;
    pixels.set(image.binary.subarray(rasterStart, rasterStart + image.width), (row + 1) * stride + 1);
  }

  let changed;
  do {
    changed = false;
    for (const pass of [1, 2]) {
      const remove = [];
      for (let row = 1; row <= image.height; row += 1) {
        const end = row * stride + image.width;
        for (let i = row * stride + 1; i <= end; i += 1) {
          if (!pixels[i]) continue;
          const mask = pixels[i - stride] | (pixels[i - stride + 1] << 1) |
            (pixels[i + 1] << 2) | (pixels[i + stride + 1] << 3) |
            (pixels[i + stride] << 4) | (pixels[i + stride - 1] << 5) |
            (pixels[i - 1] << 6) | (pixels[i - stride - 1] << 7);
          if (deletionRules[mask] & pass) remove.push(i);
        }
      }
      for (const i of remove) pixels[i] = 0;
      changed ||= remove.length > 0;
    }
  } while (changed);
  const binary = new Uint8Array(image.binary.length);
  for (let row = 0; row < image.height; row += 1) {
    const start = (row + 1) * stride + 1;
    binary.set(pixels.subarray(start, start + image.width), row * image.width);
  }
  return { ...image, binary };
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

// Tô gạch: quét các hàng cách nhau `spacing` px, nối các đoạn hàng kề nhau thành đường zíc-zắc
function hatch({ binary, width, height }, spacing) {
  const rows = [];
  for (let yf = 1; yf < height - 1; yf += spacing) {
    const y = Math.round(yf);
    const runs = [];
    let x = 0;
    while (x < width) {
      while (x < width && !binary[y * width + x]) x++;
      if (x >= width) break;
      const x0 = x;
      while (x < width && binary[y * width + x]) x++;
      if (x - 1 - x0 >= 1) runs.push({ y, x0, x1: x - 1, used: false });
    }
    rows.push(runs);
  }
  const maxJump = Math.max(2, spacing * 3);
  const paths = [];
  for (let r = 0; r < rows.length; r++) {
    for (const start of rows[r]) {
      if (start.used) continue;
      const path = [];
      let cur = start, ri = r, ltr = true;
      for (;;) {
        cur.used = true;
        const a = ltr ? cur.x0 : cur.x1, b = ltr ? cur.x1 : cur.x0;
        path.push({ x: a, y: cur.y }, { x: b, y: cur.y });
        const next = rows[ri + 1]?.filter((n) => !n.used && n.x0 <= cur.x1 && n.x1 >= cur.x0)
          .map((n) => ({ n, jump: Math.abs((ltr ? n.x1 : n.x0) - b) }))
          .sort((u, v) => u.jump - v.jump)[0];
        if (!next || next.jump > maxJump) break;
        cur = next.n; ri++; ltr = !ltr;
      }
      paths.push(path);
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

/** Trích đường nét (tọa độ pixel) theo kiểu nét */
function pixelPaths(bin, mode, spacingPx) {
  if (mode === "centerline") return traceSkeleton(thin(bin));
  const outline = trace(edges(bin)).map((points) => ({ points }));
  if (mode !== "fill") return outline;
  return outline.concat(hatch(bin, spacingPx).map((points) => ({ points, isHatch: true })));
}

/** Ánh xạ pixel → mm: giữ tỉ lệ, căn giữa vùng vẽ, trục Y hướng lên */
function transformFor(w, h, p, workArea) {
  const scale = Math.min(p.widthMm / w, p.heightMm / h);
  return { scale, w, h, offX: (workArea.width - w * scale) / 2, offY: (workArea.height - h * scale) / 2 };
}

function toMachinePaths(pxPaths, tf, p, workArea) {
  const tol = (11 - p.detail) * 0.05; // mm
  let paths = pxPaths
    .map(({ points, closed, connectsJunctions, isHatch }) => {
      const mm = points.map((q) => ({ x: tf.offX + q.x * tf.scale, y: tf.offY + (tf.h - q.y) * tf.scale }));
      // Chaikin pins endpoints, including the start of a loop attached to a junction.
      const smoothed = isHatch ? mm : chaikin(mm, p.smoothing);
      const reduced = isHatch ? smoothed : simplify(smoothed, tol);
      return { points: closed && reduced.length < 4 ? smoothed : reduced, connectsJunctions };
    })
    .filter(({ points, connectsJunctions }) => connectsJunctions || length(points) >= 0.5)
    .map(({ points }) => points);
  paths = order(paths);
  // Kẹp vào vùng vẽ (TC18: không trục nào vượt giới hạn)
  for (const pts of paths) for (const q of pts) {
    q.x = Math.min(workArea.width, Math.max(0, q.x));
    q.y = Math.min(workArea.height, Math.max(0, q.y));
  }
  return paths;
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

// ---------------- Chấm điểm độ giống ----------------

// Biến đổi khoảng cách Euclid chính xác (Felzenszwalb & Huttenlocher) — khoảng cách tới điểm mask = 1 gần nhất
function distanceTransform(mask, w, h) {
  const INF = 1e20;
  const n = Math.max(w, h);
  const g = new Float64Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = mask[i] ? 0 : INF;
  const fa = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const pass = (len) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    const sAt = (q, k) => (fa[q] + q * q - (fa[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    for (let q = 1; q < len; q++) {
      let s = sAt(q, k);
      while (s <= z[k]) { k--; s = sAt(q, k); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + fa[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) fa[y] = g[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) fa[x] = g[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
  }
  return g;
}

// Vẽ các nét (mm) ra ảnh nhị phân cùng lưới với ảnh tham chiếu, có tính bề rộng bút
function rasterize(paths, ref, tf, penWidthMm, pixelOffset) {
  const { width: W, height: H } = ref;
  const mmPerPx = (tf.w * tf.scale) / W;
  const top = tf.offY + tf.h * tf.scale;
  const r = Math.max(0.5, penWidthMm / 2 / mmPerPx);
  const out = new Uint8Array(W * H);
  const P = (q) => ({ x: (q.x - tf.offX) / mmPerPx - pixelOffset, y: (top - q.y) / mmPerPx - pixelOffset });
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const a = P(path[i - 1]), b = P(path[i]);
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r)), x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x) + r));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r)), y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y) + r));
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const t = L2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
        if ((x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= r * r) out[y * W + x] = 1;
      }
    }
  }
  return { out, mmPerPx };
}

/**
 * So bản vẽ với ảnh tham chiếu.
 * - chamferMm: trung bình 2 chiều (nét vẽ → mực gần nhất, mực → nét vẽ gần nhất), đơn vị mm. Càng nhỏ càng giống.
 * - iou: phần trăm trùng khớp diện tích nét.
 */
function evaluate(paths, ref, tf, p) {
  const { out: drawn, mmPerPx } = rasterize(paths, ref, tf, p.penWidthMm, p.mode === "centerline" ? 0.5 : 0);
  const { binary: ink, width: W, height: H } = ref;
  let nInk = 0, nDrawn = 0, inter = 0;
  for (let i = 0; i < ink.length; i++) {
    nInk += ink[i]; nDrawn += drawn[i];
    if (ink[i] && drawn[i]) inter++;
  }
  if (!nInk || !nDrawn) return { chamferMm: 99, iou: 0, extraMm: 99, missMm: 99 };
  const dInk = distanceTransform(ink, W, H);
  const dDrawn = distanceTransform(drawn, W, H);
  let extra = 0, miss = 0;
  for (let i = 0; i < ink.length; i++) {
    if (drawn[i]) extra += dInk[i];
    if (ink[i]) miss += dDrawn[i];
  }
  const extraMm = (extra / nDrawn) * mmPerPx; // vẽ thừa chỗ không có mực
  const missMm = (miss / nInk) * mmPerPx; // bỏ sót mực
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    chamferMm: r2((extraMm + missMm) / 2),
    extraMm: r2(extraMm),
    missMm: r2(missMm),
    iou: Math.round((inter / (nInk + nDrawn - inter)) * 1000) / 10,
  };
}

function estimate(paths, p) {
  let draw = 0, travel = 0, cur = { x: 0, y: 0 };
  for (const pts of paths) {
    travel += Math.hypot(pts[0].x - cur.x, pts[0].y - cur.y);
    draw += length(pts);
    cur = pts[pts.length - 1];
  }
  travel += Math.hypot(cur.x, cur.y);
  const minutes = draw / p.drawFeed + travel / p.travelFeed + (paths.length * 2 * PEN_LIFT_SECONDS) / 60;
  return { drawLengthMm: Math.round(draw), travelMm: Math.round(travel), minutes: Math.round(minutes * 10) / 10 };
}

async function referenceMask(buffer, p) {
  const gray = await loadGray(buffer, EVAL_SIZE);
  const { bin, info } = binarize(gray, p);
  return { ref: p.despeckle ? despeckle(bin, minAreaFor(bin.width, bin.height)) : bin, info };
}

// ---------------- API của module ----------------

async function buildFromGray(gray, p, workArea, cache = {}) {
  const tf = transformFor(gray.width, gray.height, p, workArea);
  if (!cache.bin) {
    const { bin, info } = binarize(gray, p);
    cache.bin = p.despeckle ? despeckle(bin, minAreaFor(bin.width, bin.height)) : bin;
    cache.info = info;
  }
  cache.px ??= {};
  const spacingPx = Math.max(1, (p.penWidthMm * 0.9) / tf.scale);
  cache.px[p.mode] ??= pixelPaths(cache.bin, p.mode, spacingPx);
  const paths = toMachinePaths(cache.px[p.mode], tf, p, workArea);
  return { tf, paths, info: cache.info };
}

/**
 * @param {Buffer} buffer ảnh PNG/JPG
 * @param {object} input tham số người dùng
 * @param {{width:number,height:number}} workArea vùng vẽ của máy (mm)
 */
async function convert(buffer, input, workArea, { refParams } = {}) {
  const p = normalizeParams(input, workArea);
  const gray = await loadGray(buffer, maxSizeFor(p.detail));
  const { tf, paths, info } = await buildFromGray(gray, p, workArea);
  // Các giá trị "auto" được thay bằng giá trị đã chọn để người dùng thấy và chạy lại được
  const used = { ...p, threshold: info.method === "adaptive" ? "adaptive" : info.level, invert: info.invert };
  // refParams: chấm điểm theo một ảnh tham chiếu cố định (để so sánh công bằng giữa các cấu hình)
  const { ref } = await referenceMask(buffer, refParams ? { ...used, ...refParams } : used);
  const gcode = toGcode(paths, used);
  const stats = {
    paths: paths.length,
    lines: gcode.split("\n").length - 1,
    ...estimate(paths, used),
    ...evaluate(paths, ref, tf, used),
    binarize: info,
    imageSize: [gray.width, gray.height],
    bbox: [tf.offX, tf.offY, tf.offX + gray.width * tf.scale, tf.offY + gray.height * tf.scale].map((v) => Math.round(v * 10) / 10),
  };
  return { gcode, params: used, stats };
}

/**
 * Tự dò tham số: thử lưới (kiểu nét × mức chi tiết × làm mượt), chấm điểm từng bộ,
 * trả về 3 phương án: Chi tiết (giống nhất), Cân bằng, Nhanh.
 */
async function autoTune(buffer, input, workArea) {
  const t0 = Date.now();
  const base = normalizeParams({ ...input, threshold: input.threshold === "adaptive" ? "adaptive" : "auto", invert: input.invert ?? "auto" }, workArea);
  const { ref, info } = await referenceMask(buffer, base);
  // Mọi bộ thử dùng cùng cách tách nét với ảnh tham chiếu → so sánh công bằng
  const fixed = { ...base, threshold: info.method === "adaptive" ? "adaptive" : info.level, invert: info.invert };

  const results = [];
  for (const detail of [3, 5, 7, 9]) {
    const gray = await loadGray(buffer, maxSizeFor(detail));
    const cache = {};
    for (const mode of ["centerline", "outline", "fill"]) {
      for (const smoothing of [0, 1, 2]) {
        const p = { ...fixed, detail, mode, smoothing };
        const { tf, paths } = await buildFromGray(gray, p, workArea, cache);
        if (!paths.length) continue;
        results.push({ params: p, metrics: { paths: paths.length, ...estimate(paths, p), ...evaluate(paths, ref, tf, p) } });
      }
    }
  }
  if (!results.length) return { candidates: [], reference: info, tried: 0, ms: Date.now() - t0 };

  // Chi tiết = sai lệch nhỏ nhất. Cân bằng / Nhanh = vẽ nhanh nhất trong số các bộ
  // có sai lệch không quá giá trị tốt nhất + 0,3 / 1,0 lần bề rộng bút.
  const cMin = Math.min(...results.map((r) => r.metrics.chamferMm));
  const fastestWithin = (tol) => results
    .filter((r) => r.metrics.chamferMm <= cMin + tol)
    .reduce((a, b) => (b.metrics.minutes < a.metrics.minutes
      || (b.metrics.minutes === a.metrics.minutes && b.metrics.chamferMm < a.metrics.chamferMm) ? b : a));

  const detailed = results.reduce((a, b) => (b.metrics.chamferMm < a.metrics.chamferMm
    || (b.metrics.chamferMm === a.metrics.chamferMm && b.metrics.minutes < a.metrics.minutes) ? b : a));
  const balanced = fastestWithin(0.3 * base.penWidthMm);
  const fast = fastestWithin(1.0 * base.penWidthMm);

  const candidates = [];
  for (const [label, r] of [["Chi tiết", detailed], ["Cân bằng", balanced], ["Nhanh", fast]]) {
    const same = candidates.find((c) => c.result === r);
    if (same) same.label += ` / ${label}`;
    else candidates.push({ label, result: r });
  }
  return {
    candidates: candidates.map(({ label, result }) => ({ label, params: result.params, metrics: result.metrics })),
    reference: info,
    tried: results.length,
    ms: Date.now() - t0,
  };
}

module.exports = { convert, autoTune, normalizeParams, DEFAULTS };
