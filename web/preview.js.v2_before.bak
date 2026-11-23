export function readMoves(gcode, { penUp, penDown }) {
  const moves = { ordered: [], distance: 0 };
  const up = penUp.toUpperCase(), lowered = penDown.toUpperCase();
  let x = 0, y = 0, down = false;
  for (const raw of gcode.split("\n")) {
    const line = raw.trim().toUpperCase();
    if (line === up) { down = false; continue; }
    if (line === lowered) { down = true; continue; }
    const match = line.match(/^G([01])\b/);
    if (!match) continue;
    const nx = Number(line.match(/X(-?[\d.]+)/)?.[1] ?? x);
    const ny = Number(line.match(/Y(-?[\d.]+)/)?.[1] ?? y);
    if (nx !== x || ny !== y) {
      const start = moves.distance;
      moves.distance += Math.hypot(nx - x, ny - y);
      moves.ordered.push({ x, y, nx, ny, ink: down && match[1] === "1", start, end: moves.distance });
    }
    x = nx; y = ny;
  }
  return moves;
}

export function playbackPosition(moves, progress) {
  const distance = progress * moves.distance;
  let first = 0, last = moves.ordered.length - 1;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (moves.ordered[middle].end <= distance) first = middle + 1;
    else last = middle;
  }
  const move = moves.ordered[first];
  const part = (distance - move.start) / (move.end - move.start);
  return { index: first, x: move.x + (move.nx - move.x) * part, y: move.y + (move.ny - move.y) * part, ink: move.ink };
}

export function paintPreview(canvas, { area, size, image, preview, view, showTravel, head }) {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  const pixelsWide = Math.round(width * scale), pixelsHigh = Math.round(height * scale);
  if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
  if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const k = Math.min((width - 52) / area.w, (height - 45) / area.h);
  if (k <= 0) return;
  const left = (width - area.w * k + 20) / 2;
  const top = (height - area.h * k - 18) / 2;
  const X = (x) => left + x * k;
  const Y = (y) => top + (area.h - y) * k;
  ctx.fillStyle = "#f8f8f5";
  ctx.fillRect(left, top, area.w * k, area.h * k);
  ctx.strokeStyle = "#9da7ad";
  ctx.lineWidth = 1;
  ctx.strokeRect(left, top, area.w * k, area.h * k);

  if ((view === "image" || view === "compare") && image?.naturalWidth) {
    const ratio = Math.min(size.w / image.naturalWidth, size.h / image.naturalHeight);
    const imageWidth = image.naturalWidth * ratio, imageHeight = image.naturalHeight * ratio;
    const bounds = preview?.stats.bbox ?? [
      (area.w - imageWidth) / 2, (area.h - imageHeight) / 2,
      (area.w + imageWidth) / 2, (area.h + imageHeight) / 2,
    ];
    ctx.globalAlpha = view === "compare" ? 0.32 : 1;
    ctx.drawImage(image, X(bounds[0]), Y(bounds[3]), (bounds[2] - bounds[0]) * k, (bounds[3] - bounds[1]) * k);
    ctx.globalAlpha = 1;
  }
  if (view !== "image" && preview) {
    ctx.lineCap = "round";
    if (showTravel) stroke(false, "#9a591f", 0.8, [3, 4]);
    stroke(true, view === "compare" ? "#075aae" : "#17252c", Math.max(1.15, preview.params.penWidthMm * k), []);
  }
  if (head) {
    ctx.beginPath();
    ctx.arc(X(head.x), Y(head.y), 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = head.ink ? "#075aae" : "#fff";
    ctx.fill();
    ctx.strokeStyle = "#075aae";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.fillStyle = getComputedStyle(canvas).color;
  ctx.font = "11px system-ui";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.fillText(String(area.h), left - 7, top + 1);
  ctx.fillText("0", left - 7, Y(0));
  ctx.textAlign = "center";
  ctx.fillText("0", left, Y(0) + 15);
  ctx.textAlign = "right";
  ctx.fillText(`${area.w} mm`, X(area.w), Y(0) + 15);

  function stroke(ink, color, weight, dash) {
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    const moves = preview.moves.ordered;
    const count = head ? head.index + 1 : moves.length;
    for (let i = 0; i < count; i++) {
      const move = moves[i];
      if (move.ink !== ink) continue;
      const partial = i === head?.index;
      if (partial && head.x === move.x && head.y === move.y) continue;
      ctx.moveTo(X(move.x), Y(move.y));
      ctx.lineTo(X(partial ? head.x : move.nx), Y(partial ? head.y : move.ny));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
