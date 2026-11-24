// Edits use millimetres on the plotter bed, independent of viewport zoom.
export const MAX_EDITS = 96;
export const MAX_BRUSH_POINTS = 256;

const EPSILON = 1e-8;
const at = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < EPSILON;

export function validateEdits(edits, width, height) {
  const point = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)
    && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height;
  if (!Array.isArray(edits) || edits.length > MAX_EDITS) return false;
  return edits.every((edit) => {
    if (edit?.type === "crop") {
      return point(edit.min) && point(edit.max)
        && edit.max.x > edit.min.x && edit.max.y > edit.min.y;
    }
    if (edit?.type === "stroke") return point(edit.point);
    return edit?.type === "erase" && Number.isFinite(edit.radius)
      && edit.radius >= 0.25 && edit.radius <= 10
      && Array.isArray(edit.points) && edit.points.length > 0
      && edit.points.length <= MAX_BRUSH_POINTS && edit.points.every(point);
  });
}

function rectangle(a, b, min, max) {
  let lo = 0, hi = 1;
  for (const key of ["x", "y"]) {
    const d = b[key] - a[key];
    if (Math.abs(d) < EPSILON) {
      if (a[key] < min[key] || a[key] > max[key]) return null;
      continue;
    }
    const u = (min[key] - a[key]) / d, v = (max[key] - a[key]) / d;
    lo = Math.max(lo, Math.min(u, v));
    hi = Math.min(hi, Math.max(u, v));
  }
  return hi - lo > EPSILON ? [lo, hi] : null;
}

function disk(a, b, c, radius) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const x = a.x - c.x, y = a.y - c.y;
  const len = dx * dx + dy * dy;
  if (!len) return null;
  const dot = x * dx + y * dy;
  const discriminant = dot * dot - len * (x * x + y * y - radius * radius);
  if (discriminant <= 0) return null;
  const root = Math.sqrt(discriminant);
  const lo = Math.max(0, (-dot - root) / len);
  const hi = Math.min(1, (-dot + root) / len);
  return hi - lo > EPSILON ? [lo, hi] : null;
}

function brushMasks(points, radius) {
  const bounds = (a, b) => ({
    min: { x: Math.min(a.x, b.x) - radius, y: Math.min(a.y, b.y) - radius },
    max: { x: Math.max(a.x, b.x) + radius, y: Math.max(a.y, b.y) + radius },
  });
  const masks = points.map((p) => ({ ...bounds(p, p), cut: (a, b) => disk(a, b, p, radius) }));
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1], end = points[i];
    const dx = end.x - start.x, dy = end.y - start.y, len = Math.hypot(dx, dy);
    if (len < EPSILON) continue;
    const min = { x: 0, y: -radius }, max = { x: len, y: radius };
    const project = ({ x, y }) => ({
      x: ((x - start.x) * dx + (y - start.y) * dy) / len,
      y: ((y - start.y) * dx - (x - start.x) * dy) / len,
    });
    masks.push({ ...bounds(start, end), cut: (a, b) => rectangle(project(a), project(b), min, max) });
  }
  return masks;
}

function survivingIntervals(a, b, masks, bounds) {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  if (minX > bounds.max.x || maxX < bounds.min.x || minY > bounds.max.y || maxY < bounds.min.y) return [[0, 1]];
  const cuts = [];
  for (const { min, max, cut } of masks) {
    if (minX > max.x || maxX < min.x || minY > max.y || maxY < min.y) continue;
    const interval = cut(a, b);
    if (interval) cuts.push(interval);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const keep = [];
  let start = 0;
  for (const [lo, hi] of cuts) {
    if (lo - start > EPSILON) keep.push([start, lo]);
    start = Math.max(start, hi);
  }
  if (1 - start > EPSILON) keep.push([start, 1]);
  return keep;
}

function clipPaths(paths, getIntervals) {
  const result = [];
  for (const path of paths) {
    let piece;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const intervals = getIntervals(a, b);
      for (const [lo, hi] of intervals) {
        const start = at(a, b, lo), end = at(a, b, hi);
        if (same(start, end)) continue;
        if (!piece || !same(piece.at(-1), start)) {
          piece = [start];
          result.push(piece);
        }
        piece.push(end);
      }
      if (!intervals.length || intervals.at(-1)[1] < 1 - EPSILON) piece = null;
    }
  }
  return result;
}

export function nearestStroke(paths, point, tolerance = 1) {
  let best = tolerance * tolerance, index = -1;
  paths.forEach((path, pathIndex) => {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len)) : 0;
      const p = at(a, b, t);
      const distance = (point.x - p.x) ** 2 + (point.y - p.y) ** 2;
      if (distance < best) { best = distance; index = pathIndex; }
    }
  });
  return index;
}

export function applyEdits(paths, edits) {
  for (const edit of edits) {
    if (edit.type === "stroke") {
      const index = nearestStroke(paths, edit.point);
      if (index !== -1) paths = paths.filter((_, i) => i !== index);
    } else if (edit.type === "crop") {
      paths = clipPaths(paths, (a, b) => {
        const interval = rectangle(a, b, edit.min, edit.max);
        return interval ? [interval] : [];
      });
    } else {
      const masks = brushMasks(edit.points, edit.radius);
      const bounds = {
        min: { x: Math.min(...edit.points.map((point) => point.x)) - edit.radius,
          y: Math.min(...edit.points.map((point) => point.y)) - edit.radius },
        max: { x: Math.max(...edit.points.map((point) => point.x)) + edit.radius,
          y: Math.max(...edit.points.map((point) => point.y)) + edit.radius },
      };
      paths = clipPaths(paths, (a, b) => survivingIntervals(a, b, masks, bounds));
    }
    if (!paths.length) break;
  }
  // Match the converter's millimetre precision and discard zero-length fragments.
  return edits.length ? paths.map((path) => {
    const rounded = path.map(({ x, y }) => ({
      x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000,
    }));
    return rounded.filter((p, i) => !i || !same(p, rounded[i - 1]));
  }).filter((path) => path.length > 1) : paths;
}
