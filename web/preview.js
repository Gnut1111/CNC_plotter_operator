export function readMoves(gcode, { penUp, penDown }) {
  const moves = { drawing: [], travel: [] };
  let x = 0, y = 0, down = false;
  for (const raw of gcode.split("\n")) {
    const line = raw.trim().toUpperCase();
    if (line === penUp.toUpperCase()) { down = false; continue; }
    if (line === penDown.toUpperCase()) { down = true; continue; }
    const match = line.match(/^G([01])\b/);
    if (!match) continue;
    const nx = Number(line.match(/X(-?[\d.]+)/)?.[1] ?? x);
    const ny = Number(line.match(/Y(-?[\d.]+)/)?.[1] ?? y);
    if (nx !== x || ny !== y) moves[down && match[1] === "1" ? "drawing" : "travel"].push([x, y, nx, ny]);
    x = nx; y = ny;
  }
  return moves;
}

export function paintPreview(canvas, { area, size, image, preview, showImage, showTravel }) {
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

  if (showImage && image?.naturalWidth) {
    const ratio = Math.min(size.w / image.naturalWidth, size.h / image.naturalHeight);
    const imageWidth = image.naturalWidth * ratio, imageHeight = image.naturalHeight * ratio;
    const bounds = preview?.stats.bbox ?? [
      (area.w - imageWidth) / 2, (area.h - imageHeight) / 2,
      (area.w + imageWidth) / 2, (area.h + imageHeight) / 2,
    ];
    ctx.drawImage(image, X(bounds[0]), Y(bounds[3]), (bounds[2] - bounds[0]) * k, (bounds[3] - bounds[1]) * k);
  } else if (!showImage && preview) {
    ctx.lineCap = "round";
    if (showTravel) stroke(preview.moves.travel, "#b37754", 0.8, [3, 4]);
    stroke(preview.moves.drawing, "#17252c", Math.max(1.15, preview.params.penWidthMm * k), []);
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

  function stroke(moves, color, weight, dash) {
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    for (const [x, y, nx, ny] of moves) {
      ctx.moveTo(X(x), Y(y));
      ctx.lineTo(X(nx), Y(ny));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
