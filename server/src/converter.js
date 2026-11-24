// Converter: ảnh PNG/JPG → đường nét → G-code
// Thuật toán gốc port từ bản web tĩnh cũ (repo CNC_Ploter/app.js), chạy trên server bằng sharp.
// Bổ sung: ngưỡng tự động (Otsu / thích nghi), tự đảo màu, xóa đốm nhiễu, tô gạch (fill),
// chấm điểm độ giống ảnh gốc (Chamfer, IoU) và tự dò bộ tham số tốt nhất (autoTune).
const sharp = require("sharp");
const { traceSkeleton } = require("./trace-paths");
const { performance } = require("node:perf_hooks");
const { profile: MACHINE, limitArea } = require("./machine-profile");

const DEFAULTS = {
  widthMm: MACHINE.workArea.width, // kích thước bản vẽ mong muốn (giữ tỉ lệ ảnh)
  heightMm: MACHINE.workArea.height,
  detail: 10, // 1..10 — cao hơn = độ phân giải xử lý cao hơn, ít đơn giản hóa hơn
  threshold: "auto", // "auto" | "adaptive" | số 1..254
  invert: "auto", // "auto" | true | false
  mode: "centerline", // "centerline" (đường tâm) | "outline" (đường viền) | "fill" (viền + tô gạch)
  smoothing: 1, // 0..3 vòng làm mượt Chaikin
  simplifyMm: null, // null: theo mức chi tiết
  hatchRatio: 0.9, // khoảng gạch theo bề rộng bút
  fillStrategy: "legacy",
  rasterPx: null, // null: theo mức chi tiết
  despeckle: true, // xóa đốm nhiễu nhỏ
  penWidthMm: 0.5, // bề rộng nét bút — dùng cho khoảng cách tô gạch và chấm điểm
  controlledTravelFeed: null,
  penLiftZ: MACHINE.penLiftMax,
  penLowerFeed: MACHINE.penLowerFeedMax,
  travelFeed: MACHINE.rapidFeed,
  drawFeed: MACHINE.drawFeed,
  penUp: MACHINE.penUp,
  penDown: MACHINE.penDown,
};

const EVAL_SIZE = 400;
const VERIFY_SIZE = 960;
const TUNE_TIMEOUT_MS = { fast: 14500, detail: 44500, both: 44500 };

function normalizeParams(input = {}, workArea) {
  workArea = limitArea(workArea);
  const p = { ...DEFAULTS };
  const num = (v, min, max, def) => {
    const n = Number(v);
    return v !== "" && v !== null && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  p.widthMm = num(input.widthMm, 1, workArea.width, Math.min(DEFAULTS.widthMm, workArea.width));
  p.heightMm = num(input.heightMm, 1, workArea.height, Math.min(DEFAULTS.heightMm, workArea.height));
  p.detail = Math.round(num(input.detail, 1, 10, DEFAULTS.detail));
  p.threshold = ["auto", "adaptive"].includes(input.threshold)
    ? input.threshold
    : Math.round(num(input.threshold, 1, 254, "auto")) || "auto";
  if (input.invert === true || input.invert === "true") p.invert = true;
  else if (input.invert === false || input.invert === "false") p.invert = false;
  p.mode = ["outline", "fill"].includes(input.mode) ? input.mode : "centerline";
  p.smoothing = Math.round(num(input.smoothing, 0, 3, DEFAULTS.smoothing));
  p.simplifyMm = num(input.simplifyMm, 0.03, 1, null);
  p.hatchRatio = num(input.hatchRatio, 0.6, 1, DEFAULTS.hatchRatio);
  if (["inset-x", "inset-y"].includes(input.fillStrategy)) p.fillStrategy = input.fillStrategy;
  p.rasterPx = num(input.rasterPx, 210, 1280, null);
  if (p.rasterPx !== null) p.rasterPx = Math.round(p.rasterPx);
  p.despeckle = !(input.despeckle === false || input.despeckle === "false");
  p.penWidthMm = num(input.penWidthMm, 0.1, 3, DEFAULTS.penWidthMm);
  p.drawFeed = Math.round(num(input.drawFeed, MACHINE.minFeed, MACHINE.drawFeed, DEFAULTS.drawFeed));
  p.controlledTravelFeed = num(input.controlledTravelFeed, MACHINE.minFeed, MACHINE.controlledTravelMax, null);
  if (p.controlledTravelFeed !== null) p.controlledTravelFeed = Math.round(p.controlledTravelFeed);
  p.travelFeed = p.controlledTravelFeed ?? MACHINE.rapidFeed;
  p.penLiftZ = Math.round(num(input.penLiftZ, 0.1, MACHINE.penLiftMax, DEFAULTS.penLiftZ) * 10) / 10;
  p.penLowerFeed = Math.round(num(input.penLowerFeed, MACHINE.minFeed, MACHINE.penLowerFeedMax, DEFAULTS.penLowerFeed));
  p.penUp = `G0 Z${p.penLiftZ}`;
  p.penDown = `G1 Z0 F${p.penLowerFeed}`;
  return p;
}

const maxSizeFor = (p) => p.rasterPx ?? 150 + p.detail * 60;

async function loadGray(buffer, maxSize, enlarge = false) {
  const { data, info } = await sharp(buffer, { limitInputPixels: 25_000_000 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: !enlarge })
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
    if (y >= height) break;
    const runs = [];
    let x = 0;
    while (x < width) {
      while (x < width && !binary[y * width + x]) x++;
      if (x >= width) break;
      const x0 = x;
      while (x < width && binary[y * width + x]) x++;
      if (x - 1 - x0 >= 1) runs.push({ y: yf, x0, x1: x - 1, used: false });
    }
    rows.push(runs);
  }
  function inside(x0, y0, x1, y1) {
    const steps = Math.ceil(2 * Math.hypot(x1 - x0, y1 - y0));
    for (let i = 1; i < steps; i++) {
      const x = Math.round(x0 + (x1 - x0) * i / steps);
      const y = Math.round(y0 + (y1 - y0) * i / steps);
      if (!binary[y * width + x]) return false;
    }
    return true;
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
        path.push({ x: a + 0.5, y: cur.y + 0.5 }, { x: b + 0.5, y: cur.y + 0.5 });
        const next = rows[ri + 1]?.filter((n) => !n.used && n.x0 <= cur.x1 && n.x1 >= cur.x0)
          .map((n) => ({ n, jump: Math.abs((ltr ? n.x1 : n.x0) - b) }))
          .sort((u, v) => u.jump - v.jump)[0];
        if (!next || next.jump > maxJump) break;
        const end = ltr ? next.n.x1 : next.n.x0;
        if (!inside(b, cur.y, end, next.n.y)) {
          // Turn via a shared column to avoid cutting across a concave edge.
          const x = Math.min(Math.min(cur.x1, next.n.x1), Math.max(b, cur.x0, next.n.x0));
          if (!inside(x, cur.y, x, next.n.y)) break;
          if (x !== b) path.push({ x: x + 0.5, y: cur.y + 0.5 });
          if (x !== end) path.push({ x: x + 0.5, y: next.n.y + 0.5 });
        }
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
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const pending = [[0, points.length - 1]];
  while (pending.length) {
    const [s, e] = pending.pop();
    let max = sq, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx !== -1) { keep[idx] = 1; pending.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
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
  const out = [];
  const rest = [...paths];
  if (rest.length > 256) {
    // Limit nearest-neighbor search to nearby bands on dense drawings.
    const tile = ([p]) => {
      const row = Math.floor(p.y / 10), column = Math.floor(p.x / 10);
      return [row, row % 2 ? -column : column];
    };
    rest.sort((a, b) => {
      const [rowA, colA] = tile(a), [rowB, colB] = tile(b);
      return rowA - rowB || colA - colB;
    });
  }
  let cur = { x: 0, y: 0 };
  for (let start = 0; start < rest.length; start += 96) {
    const end = rest.length <= 256 ? rest.length : Math.min(start + 96, rest.length);
    for (let i = start; i < end; i++) {
      let best = i, rev = false, bestD = Infinity;
      for (let j = i; j < end; j++) {
        const p = rest[j], a = p[0], b = p.at(-1);
        const da = (a.x - cur.x) ** 2 + (a.y - cur.y) ** 2;
        const db = (b.x - cur.x) ** 2 + (b.y - cur.y) ** 2;
        if (da < bestD) { bestD = da; best = j; rev = false; }
        if (db < bestD) { bestD = db; best = j; rev = true; }
      }
      const p = rest[best];
      rest[best] = rest[i];
      if (rev) p.reverse();
      out.push(p);
      cur = p.at(-1);
    }
    if (end === rest.length) break;
  }
  return out;
}

// Sweep only where the pen fits. Fall back to the skeleton in thin regions.
function insetFill(bin, spacing, radius, vertical, cache) {
  const { binary, width, height } = bin;
  cache.wallDistance ??= distanceTransform(binary.map((v) => 1 - v), width, height);
  const core = binary.map((v, i) => Number(v && cache.wallDistance[i] >= radius + 0.25));
  cache.skeleton ??= thin(bin);
  if (!core.some(Boolean)) return traceSkeleton(cache.skeleton);

  const coreDistance = distanceTransform(core, width, height);
  const thinOnly = cache.skeleton.binary.map((v, i) => Number(v && coreDistance[i] > Math.max(1, radius)));
  const lines = traceSkeleton({ binary: thinOnly, width, height })
    .concat(traceSkeleton(edges({ binary: core, width, height })));

  if (!vertical) return lines.concat(hatch({ binary: core, width, height }, spacing).map((points) => ({ points, isHatch: true })));
  const transposed = new Uint8Array(binary.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) transposed[x * height + y] = core[y * width + x];
  return lines.concat(hatch({ binary: transposed, width: height, height: width }, spacing)
    .map((points) => ({ points: points.map(({ x, y }) => ({ x: y, y: x })), isHatch: true })));
}

/** Trích đường nét (tọa độ pixel) theo kiểu nét */
function pixelPaths(cache, p, tf, spacingPx) {
  const bin = cache.bin, mode = p.mode;
  if (mode === "centerline") return traceSkeleton(cache.skeleton ??= thin(bin));
  if (mode === "fill" && p.fillStrategy !== "legacy") {
    return insetFill(bin, spacingPx, p.penWidthMm / (2 * tf.scale), p.fillStrategy === "inset-y", cache);
  }
  const outline = cache.outline ??= trace(edges(bin)).map((points) => ({ points }));
  if (mode !== "fill") return outline;
  return outline.concat(hatch(bin, spacingPx).map((points) => ({ points, isHatch: true })));
}

/** Ánh xạ pixel → mm: giữ tỉ lệ, căn giữa vùng vẽ, trục Y hướng lên */
function transformFor(w, h, p, workArea) {
  const scale = Math.min(p.widthMm / w, p.heightMm / h);
  return { scale, w, h, offX: (workArea.width - w * scale) / 2, offY: (workArea.height - h * scale) / 2 };
}

// Reuse an existing junction as a continuous pen-down move. No connector is added.
function joinCenterlines(paths) {
  const ends = new Map();
  const open = [], closed = [];
  const key = ({ x, y }) => `${x},${y}`;
  const vertex = (point) => {
    const id = key(point);
    if (!ends.has(id)) ends.set(id, { edges: [], next: 0 });
    return ends.get(id);
  };
  for (const points of paths) {
    const head = vertex(points[0]), tail = vertex(points.at(-1));
    if (head === tail) { closed.push(points); continue; }
    const edge = { points, head, tail, used: false };
    head.edges.push(edge);
    tail.edges.push(edge);
  }
  function nextEdge(at) {
    while (at.edges[at.next]?.used) at.next++;
    return at.edges[at.next];
  }
  for (const oddFirst of [true, false]) {
    for (const vertex of ends.values()) {
      if (oddFirst && vertex.edges.length % 2 === 0) continue;
      while (nextEdge(vertex)) {
        const trail = [];
        let at = vertex, edge;
        while ((edge = nextEdge(at))) {
          edge.used = true;
          const { points, head, tail } = edge;
          if (at === head) {
            for (let i = trail.length ? 1 : 0; i < points.length; i++) trail.push(points[i]);
            at = tail;
          } else {
            for (let i = points.length - (trail.length ? 2 : 1); i >= 0; i--) trail.push(points[i]);
            at = head;
          }
        }
        open.push(trail);
      }
    }
  }
  return closed.concat(open);
}

function toMachinePaths(pxPaths, tf, p, workArea) {
  const tol = p.simplifyMm ?? (11 - p.detail) * 0.05;
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
  // Compare float-to-step truncation as in the Pico, keeping coordinates in mm.
  const pulse = (mm, steps) => Math.trunc(Math.fround(Math.fround(mm) * steps));
  const clamp = (v, limit) => Math.min(Math.floor(limit * 1000) / 1000, Math.max(0, Math.round(v * 1000) / 1000));
  paths = paths.map((points) => {
    let px, py;
    const compact = [];
    for (const q of points) {
      const x = clamp(q.x, workArea.width), y = clamp(q.y, workArea.height);
      const sx = pulse(x, MACHINE.stepsPerMm.x), sy = pulse(y, MACHINE.stepsPerMm.y);
      if (sx === px && sy === py) continue;
      px = sx;
      py = sy;
      compact.push({ x, y });
    }
    return compact;
  }).filter((points) => points.length > 1);
  return order(p.mode === "centerline" ? joinCenterlines(paths) : paths);
}

const f = (v) => (Math.round(v * 1000) / 1000).toString();

function toGcode(paths, p) {
  const lines = ["; Pixel2Plot - CNC_plotter_operator", "G21", "G90", p.penUp];
  const travel = (x, y) => p.controlledTravelFeed === null
    ? `G0 X${f(x)} Y${f(y)}`
    : `G1 X${f(x)} Y${f(y)} F${p.controlledTravelFeed}`;
  for (const path of paths) {
    const [s, ...rest] = path;
    lines.push(travel(s.x, s.y));
    lines.push(p.penDown);
    for (const q of rest) lines.push(`G1 X${f(q.x)} Y${f(q.y)} F${p.drawFeed}`);
    lines.push(p.penUp);
  }
  lines.push(travel(0, 0), "M2");
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
function rasterize(paths, ref, tf, penWidthMm) {
  const { width: W, height: H } = ref;
  const mmPerPx = (tf.w * tf.scale) / W;
  const top = tf.offY + tf.h * tf.scale;
  const mmPerPy = (tf.h * tf.scale) / H;
  const r = Math.max(penWidthMm / 2, Math.min(mmPerPx, mmPerPy) / 2);
  const rx = r / mmPerPx, ry = r / mmPerPy;
  const out = new Uint8Array(W * H);
  const P = (q) => ({ x: (q.x - tf.offX) / mmPerPx - 0.5, y: (top - q.y) / mmPerPy - 0.5 });
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const a = P(path[i - 1]), b = P(path[i]);
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - rx)), x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x) + rx));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - ry)), y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y) + ry));
      const dx = (b.x - a.x) * mmPerPx, dy = (b.y - a.y) * mmPerPy, L2 = dx * dx + dy * dy;
      for (let y = y0; y <= y1; y++) {
        let start = x0, end = x1;
        if (b.y !== a.y) {
          const t0 = (y - ry - a.y) / (b.y - a.y), t1 = (y + ry - a.y) / (b.y - a.y);
          const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
          if (lo > hi) continue;
          const xa = a.x + (b.x - a.x) * lo, xb = a.x + (b.x - a.x) * hi;
          start = Math.max(start, Math.floor(Math.min(xa, xb) - rx));
          end = Math.min(end, Math.ceil(Math.max(xa, xb) + rx));
        }
        for (let x = start; x <= end; x++) {
          const ex = (x - a.x) * mmPerPx, ey = (y - a.y) * mmPerPy;
          const t = L2 ? Math.max(0, Math.min(1, (ex * dx + ey * dy) / L2)) : 0;
          if ((ex - t * dx) ** 2 + (ey - t * dy) ** 2 <= r * r) out[y * W + x] = 1;
        }
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
function evaluate(paths, ref, tf, p, dInk, strict = false) {
  const { out: drawn, mmPerPx } = rasterize(paths, ref, tf, p.penWidthMm);
  const { binary: ink, width: W, height: H } = ref;
  let nInk = 0, nDrawn = 0, inter = 0;
  for (let i = 0; i < ink.length; i++) {
    nInk += ink[i]; nDrawn += drawn[i];
    if (ink[i] && drawn[i]) inter++;
  }
  if (!nInk || !nDrawn) return { chamferMm: 99, iou: 0, extraMm: 99, missMm: 99, coverage: 0, precision: 0, inkRecall: 0, inkPrecision: 0, score: 0 };
  dInk ??= distanceTransform(ink, W, H);
  const dDrawn = distanceTransform(drawn, W, H);
  let extra = 0, miss = 0, covered = 0, precise = 0;
  const tolerance = Math.max(1, (strict ? Math.min(0.20, p.penWidthMm / 2) : p.penWidthMm / 2) / mmPerPx);
  for (let i = 0; i < ink.length; i++) {
    if (drawn[i]) { extra += dInk[i]; if (dInk[i] <= tolerance) precise++; }
    if (ink[i]) { miss += dDrawn[i]; if (dDrawn[i] <= tolerance) covered++; }
  }
  const extraMm = (extra / nDrawn) * mmPerPx; // vẽ thừa chỗ không có mực
  const missMm = (miss / nInk) * mmPerPx; // bỏ sót mực
  const r2 = (v) => Math.round(v * 100) / 100;
  const coverage = covered / nInk, precision = precise / nDrawn;
  const f1 = coverage + precision ? 2 * precision * coverage / (precision + coverage) : 0;
  const iou = inter / (nInk + nDrawn - inter);
  return {
    coverage: r2(100 * coverage), precision: r2(100 * precision),
    inkRecall: r2(100 * inter / nInk), inkPrecision: r2(100 * inter / nDrawn),
    score: r2(100 * (strict ? 0.8 * iou + 0.2 * f1 : 0.6 * iou + 0.4 * f1)),
    chamferMm: r2((extraMm + missMm) / 2),
    extraMm: r2(extraMm),
    missMm: r2(missMm),
    iou: Math.round(iou * 1000) / 10,
  };
}

function estimate(paths, p) {
  let draw = 0, travel = 0, seconds = 0, cur = { x: 0, y: 0 };
  // Approximate stop-and-go ramps using the legacy controller's 400 mm/s².
  const timeFor = (distance, feed) => {
    const speed = feed / 60, accel = MACHINE.accelMmS2;
    return distance < speed * speed / accel
      ? 2 * Math.sqrt(distance / accel)
      : distance / speed + speed / accel;
  };
  for (const pts of paths) {
    const approach = Math.hypot(pts[0].x - cur.x, pts[0].y - cur.y);
    travel += approach;
    seconds += timeFor(approach, p.travelFeed) + 2 * MACHINE.penTransitionSeconds;
    for (let i = 1; i < pts.length; i++) {
      const mm = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      draw += mm;
      seconds += timeFor(mm, p.drawFeed);
    }
    cur = pts.at(-1);
  }
  const home = Math.hypot(cur.x, cur.y);
  travel += home;
  seconds += timeFor(home, p.travelFeed);
  return { drawLengthMm: Math.round(draw), travelMm: Math.round(travel), seconds: Math.round(seconds), minutes: Math.round(seconds / 6) / 10 };
}

function sourceReference(gray) {
  const level = otsu(gray);
  // The frame is a better background cue than total ink area for dense logos.
  let dark = 0, count = 0;
  const classify = (x, y) => { dark += Number(gray.data[y * gray.width + x] < level); count++; };
  for (let x = 0; x < gray.width; x++) {
    classify(x, 0);
    if (gray.height > 1) classify(x, gray.height - 1);
  }
  for (let y = 1; y < gray.height - 1; y++) {
    classify(0, y);
    if (gray.width > 1) classify(gray.width - 1, y);
  }
  const invert = dark > 0.75 * count;
  const litGray = invert ? { ...gray, data: gray.data.map((v) => 255 - v) } : gray;
  const threshold = unevenLighting(litGray, invert ? 256 - level : level) ? "adaptive" : level;
  return { threshold, invert, despeckle: true };
}

function referenceMask(gray, params = sourceReference(gray)) {
  const { bin, info } = binarize(gray, params);
  return { ref: params.despeckle ? despeckle(bin, minAreaFor(bin.width, bin.height)) : bin, info };
}

// ---------------- API của module ----------------

function buildFromGray(gray, p, workArea, cache = {}) {
  const tf = transformFor(gray.width, gray.height, p, workArea);
  if (!cache.bin) {
    const { bin, info } = binarize(gray, p);
    cache.bin = p.despeckle ? despeckle(bin, minAreaFor(bin.width, bin.height)) : bin;
    cache.info = info;
  }
  cache.px ??= {};
  const spacingPx = Math.max(0.5, p.penWidthMm * p.hatchRatio / tf.scale);
  const key = p.mode === "fill" ? `fill:${p.fillStrategy}:${spacingPx}` : p.mode;
  cache.px[key] ??= pixelPaths(cache, p, tf, spacingPx);
  const paths = toMachinePaths(cache.px[key], tf, p, workArea);
  return { tf, paths, info: cache.info };
}

function readInkPaths(gcode, p) {
  let current = { x: 0, y: 0 }, path;
  const paths = [];
  for (const raw of gcode.split("\n")) {
    const line = raw.trim().toUpperCase();
    if (line === p.penUp.trim().toUpperCase()) { path = null; continue; }
    if (line === p.penDown.trim().toUpperCase()) { path = [current]; continue; }
    const move = /^G([01]) X([\d.]+) Y([\d.]+)/.exec(line);
    if (!move) continue;
    const next = { x: +move[2], y: +move[3] };
    if (move[1] === "1" && path && (next.x !== current.x || next.y !== current.y)) {
      if (path.length === 1) paths.push(path);
      path.push(next);
    }
    current = next;
  }
  return paths;
}

async function scoringReference(buffer, refParams) {
  const coarse = await loadGray(buffer, EVAL_SIZE);
  const source = sourceReference(coarse);
  const gray = await loadGray(buffer, VERIFY_SIZE, true);
  const { ref, info } = referenceMask(gray, refParams ?? source);
  return { coarse, source, ref, info };
}

function scoreOutput(gcode, ref, p, workArea, dInk) {
  const tf = transformFor(ref.width, ref.height, p, workArea);
  return evaluate(readInkPaths(gcode, p), ref, tf, p, dInk, true);
}

// Use the same normalized footprint to compare saved G-code from different generators.
async function assessGcode(buffer, gcode, input, workArea) {
  const { ref } = await scoringReference(buffer);
  const params = normalizeParams(input, workArea);
  return scoreOutput(gcode, ref, { ...params, penUp: input.penUp ?? params.penUp, penDown: input.penDown ?? params.penDown }, workArea);
}

/**
 * @param {Buffer} buffer ảnh PNG/JPG
 * @param {object} input tham số người dùng
 * @param {{width:number,height:number}} workArea vùng vẽ của máy (mm)
 */
async function convert(buffer, input, workArea, { refParams, edits, includePaths = false } = {}) {
  workArea = limitArea(workArea);
  const p = normalizeParams(input, workArea);
  const pathEditor = edits === undefined ? null : await import("../../web/path-edits.mjs");
  if (pathEditor && !pathEditor.validateEdits(edits, workArea.width, workArea.height)) {
    throw new Error("Vùng chỉnh sửa không hợp lệ hoặc nằm ngoài bàn vẽ.");
  }
  const gray = await loadGray(buffer, maxSizeFor(p));
  const { tf, paths: sourcePaths, info } = buildFromGray(gray, p, workArea);
  const paths = pathEditor ? pathEditor.applyEdits(sourcePaths, edits) : sourcePaths;
  // Các giá trị "auto" được thay bằng giá trị đã chọn để người dùng thấy và chạy lại được
  const used = { ...p, threshold: info.method === "adaptive" ? "adaptive" : info.level, invert: info.invert };
  // refParams: chấm điểm theo một ảnh tham chiếu cố định (để so sánh công bằng giữa các cấu hình)
  const { ref } = await scoringReference(buffer, refParams);
  const gcode = toGcode(paths, used);
  const stats = {
    paths: paths.length,
    lines: gcode.split("\n").length - 1,
    ...estimate(paths, used),
    ...scoreOutput(gcode, ref, used, workArea),
    binarize: info,
    imageSize: [gray.width, gray.height],
    bbox: [tf.offX, tf.offY, tf.offX + gray.width * tf.scale, tf.offY + gray.height * tf.scale].map((v) => Math.round(v * 10) / 10),
  };
  return { gcode, params: used, stats, ...(includePaths ? { sourcePaths } : {}) };
}

/** Search shape first, then refine the best candidates against the same ink mask. */
async function autoTune(buffer, input, workArea, profile = "both", onVerified) {
  workArea = limitArea(workArea);
  if (!["fast", "detail", "both"].includes(profile)) throw new Error("Chế độ tìm cấu hình không hợp lệ.");
  const start = performance.now();
  const quick = profile === "fast";
  const searchUntil = start + (quick ? 9500 : 32500);
  const verifyUntil = start + (quick ? 13000 : 41500);
  let timeLimited = false;
  const base = normalizeParams(input, workArea);
  const { coarse: evalGray, source, ref: verifyRef } = await scoringReference(buffer);
  const { ref, info } = referenceMask(evalGray, source);
  const results = [], visited = new Set(), grays = new Map(), caches = new Map();
  const reply = (candidates) => ({
    candidates, reference: info, tried: visited.size, ms: Math.round(performance.now() - start),
    verified: candidates.length ? verifiedCount : 0, timeLimited,
  });
  let verifiedCount = 0;
  if (!ref.binary.some(Boolean) && !verifyRef.binary.some(Boolean)) return reply([]);
  const dInk = distanceTransform(ref.binary, ref.width, ref.height);
  const fixed = { ...base, ...source, fillStrategy: "legacy", rasterPx: null };

  async function tryPlan(params) {
    if (performance.now() >= searchUntil) { timeLimited = true; return; }
    const key = JSON.stringify(params);
    if (visited.has(key)) return;
    visited.add(key);
    const size = maxSizeFor(params);
    if (!grays.has(size)) grays.set(size, await loadGray(buffer, size));
    const group = [size, params.threshold, params.invert, params.despeckle].join("/");
    const cache = caches.get(group) || {};
    caches.delete(group);
    caches.set(group, cache);
    if (caches.size > 6) caches.delete(caches.keys().next().value);
    const { paths, tf } = buildFromGray(grays.get(size), params, workArea, cache);
    if (!paths.length) return;
    const metrics = evaluate(paths, ref, tf, params, dInk);
    results.push({ params, metrics: { paths: paths.length, ...metrics, ...estimate(paths, params) } });
  }

  const modes = ["centerline", "outline", "fill"];
  await tryPlan({ ...fixed, mode: base.mode, fillStrategy: base.fillStrategy, rasterPx: base.rasterPx });
  for (const detail of [5, 3, 7, 9]) {
    for (const mode of modes) {
      for (const smoothing of [1, 0, 2]) {
        await tryPlan({ ...fixed, detail, mode, smoothing });
      }
    }
  }

  const threshold = otsu(evalGray);
  const globalOptions = [threshold, threshold - 15, threshold + 15, threshold + 35]
    .map((v) => Math.max(1, Math.min(254, v)));
  const thresholds = new Set([source.threshold, ...globalOptions, "adaptive"]);
  if (typeof base.threshold === "number") thresholds.add(base.threshold);
  for (const level of thresholds) {
    for (const mode of modes) {
      for (const despeckle of [true, false]) {
        await tryPlan({ ...fixed, detail: 5, mode, threshold: level, despeckle, smoothing: 1 });
      }
    }
  }

  const rank = (a, b) => b.metrics.score - a.metrics.score
    || a.metrics.chamferMm - b.metrics.chamferMm || a.metrics.seconds - b.metrics.seconds;
  for (const seed of modes.map((mode) => results.filter((r) => r.params.mode === mode).sort(rank)[0]).filter(Boolean)) {
    const p = seed.params;
    for (const detail of new Set([p.detail, 2, 6, 10])) {
      for (const simplifyMm of [0.10, 0.30, 0.55]) {
        await tryPlan({ ...p, detail, simplifyMm });
      }
    }
    for (const smoothing of [0, 2, 3]) await tryPlan({ ...p, smoothing });
    if (p.mode === "fill") {
      for (const hatchRatio of [0.65, 0.8, 1]) {
        for (const detail of [p.detail, 4, 8]) await tryPlan({ ...p, detail, hatchRatio });
      }
    }
  }

  const legacy = results.filter(({ params }) => params.fillStrategy === "legacy").sort(rank);
  const legacyLeader = legacy[0];
  const legacyFast = legacyLeader && legacy.filter(({ metrics: m }) => m.score >= legacyLeader.metrics.score - 6
    && m.coverage >= legacyLeader.metrics.coverage - 8 && m.precision >= legacyLeader.metrics.precision - 8)
    .sort((a, b) => a.metrics.seconds - b.metrics.seconds || rank(a, b))[0];
  // Preserve the current search as a seed, then try additional pen-aware raster variants.
  const seedModes = modes.map((mode) => results.filter((r) => r.params.mode === mode).sort(rank)[0]).filter(Boolean);
  const fillSeed = seedModes.find(({ params }) => params.mode === "fill");
  if (fillSeed) {
    for (const fillStrategy of ["inset-x", "inset-y"]) {
      for (const detail of [4, 7, 10]) {
        for (const hatchRatio of [0.65, 0.85, 1]) {
          await tryPlan({ ...fillSeed.params, fillStrategy, detail, hatchRatio });
        }
      }
    }
  }
  if (!quick) {
    const leaders = [...seedModes, ...results.filter(({ params }) => params.fillStrategy !== "legacy").sort(rank).slice(0, 2)];
    for (const { params: p } of leaders) {
      for (const rasterPx of [900, 1120, 1280]) {
        for (const simplifyMm of [0.06, 0.15, 0.35]) await tryPlan({ ...p, rasterPx, simplifyMm });
      }
      if (typeof p.threshold === "number") {
        for (const delta of [-8, 8, 24]) {
          for (const smoothing of [0, 1, 2]) {
            await tryPlan({ ...p, threshold: Math.max(1, Math.min(254, p.threshold + delta)), smoothing });
          }
        }
      }
    }
  }

  if (!results.length) return reply([]);
  // Re-rank distinct geometry families and a few shorter routes on the same 960px mask.
  const finalists = new Set();
  const byOverlap = (a, b) => b.metrics.iou - a.metrics.iou || rank(a, b);
  const byTime = (a, b) => a.metrics.seconds - b.metrics.seconds || byOverlap(a, b);
  const byScore = results.sort(rank);
  const topScore = byScore[0].metrics.score;
  if (legacyLeader) finalists.add(legacyLeader);
  if (legacyFast) finalists.add(legacyFast);
  finalists.add(byScore[0]);
  finalists.add(byScore.filter((r) => r.metrics.score >= topScore - 6
    && r.metrics.coverage >= byScore[0].metrics.coverage - 8
    && r.metrics.precision >= byScore[0].metrics.precision - 8).sort(byTime)[0]);
  const overlaps = [...results].sort(byOverlap);
  for (const r of overlaps.slice(0, quick ? 6 : 14)) finalists.add(r);
  for (const mode of modes) {
    for (const r of overlaps.filter(({ params }) => params.mode === mode).slice(0, quick ? 2 : 4)) finalists.add(r);
  }
  for (const r of overlaps.filter(({ params }) => params.fillStrategy !== "legacy").slice(0, quick ? 2 : 5)) finalists.add(r);
  for (const r of [...results].filter(({ metrics }) => metrics.score >= topScore - 8).sort(byTime).slice(0, quick ? 4 : 8)) finalists.add(r);

  const verified = [];
  let recallFloor = 0;
  function choices() {
    if (!verified.length) return [];
    const eligible = verified.filter(({ metrics }) => metrics.inkRecall >= recallFloor);
    const detailed = eligible.sort(byOverlap)[0];
    const fast = eligible.filter(({ metrics: m }) => m.iou >= detailed.metrics.iou - 4
      && m.score >= detailed.metrics.score - 5 && m.inkRecall >= detailed.metrics.inkRecall - 5
      && m.inkPrecision >= detailed.metrics.inkPrecision - 5).sort(byTime)[0];
    const result = [];
    if (profile !== "fast") result.push({ id: "detail", label: "Chi tiết", ...detailed });
    if (profile !== "detail") result.push({ id: "fast", label: "Nhanh", ...fast });
    return result;
  }
  const highDistances = distanceTransform(verifyRef.binary, verifyRef.width, verifyRef.height);
  for (const { params, metrics } of finalists) {
    if (verified.length && performance.now() >= verifyUntil) { timeLimited = true; break; }
    const gray = grays.get(maxSizeFor(params));
    const { paths } = buildFromGray(gray, params, workArea);
    const gcode = toGcode(paths, params);
    const finalMetrics = scoreOutput(gcode, verifyRef, params, workArea, highDistances);
    if (finalMetrics.score) {
      if (params === legacyLeader?.params) recallFloor = Math.max(0, finalMetrics.inkRecall - 6);
      verified.push({ params, metrics: { ...metrics, ...finalMetrics } });
      verifiedCount++;
      if (verifiedCount === 1 || verifiedCount % 4 === 0) onVerified?.(reply(choices()));
    }
  }
  return reply(choices());
}

module.exports = { convert, autoTune, assessGcode, normalizeParams, DEFAULTS, TUNE_TIMEOUT_MS };
