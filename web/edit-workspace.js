import { applyEdits, MAX_BRUSH_POINTS, MAX_EDITS, nearestStroke } from "./path-edits.mjs";
import { canvasTransform } from "./preview.js";

const KEEP_VERSIONS = 24;
const names = { crop: "Cắt vùng", erase: "Tẩy nét", stroke: "Xóa cả nét" };
const pointDistance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const rectangle = (a, b) => ({
  type: "crop",
  min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
  max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
});
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function mountDrawingEditor({
  root, canvas, getArea, getPreview, isLocked, hasFile, selectPaths, redraw, onEdit, onStateChange,
}) {
  const find = (id) => root.querySelector(`#${id}`);
  const tools = [...root.querySelectorAll("[data-edit-tool]")];
  const undo = find("drawingUndo"), redo = find("drawingRedo");
  const history = find("drawingHistory"), versions = find("drawingVersions");
  const zoomOut = find("drawingZoomOut"), zoomIn = find("drawingZoomIn"), fit = find("drawingZoomReset");
  const brush = find("drawingBrushSize"), applyCrop = find("drawingApplyCrop");
  const status = find("drawingEditStatus");
  let current, past, future, archive;
  let camera = { zoom: 1, x: 0, y: 0 };
  let tool = "", crop, gesture, overlay, selectedPaths = [];
  let pathsFor, editsFor;

  function reset(state) {
    const initial = { label: "Bản chưa chỉnh", at: null, edits: [] };
    current = state?.current ?? initial;
    past = state?.past ?? [];
    future = state?.future ?? [];
    archive = state?.archive ?? [];
    tool = "";
    pathsFor = null;
    selectedPaths = [];
    camera = { zoom: 1, x: 0, y: 0 };
    clearGesture();
    history.open = false;
    renderHistory();
  }

  const editable = () => !isLocked() && Boolean(getPreview()?.sourcePaths?.length);
  const currentEdits = () => current.edits;

  function activePaths() {
    const source = getPreview()?.sourcePaths;
    if (!source) return [];
    if (pathsFor !== source || editsFor !== current.edits) {
      selectedPaths = applyEdits(source, current.edits);
      pathsFor = source;
      editsFor = current.edits;
    }
    return selectedPaths;
  }

  function sync() {
    root.hidden = !hasFile();
    const locked = isLocked();
    const ready = editable();
    const canPan = !locked && hasFile() && camera.zoom > 1;
    for (const button of tools) {
      const name = button.dataset.editTool;
      button.disabled = name === "pan" ? !canPan : !ready || current.edits.length >= MAX_EDITS;
      button.setAttribute("aria-pressed", String(tool === name));
    }
    undo.disabled = locked || !past.length;
    redo.disabled = locked || !future.length;
    for (const item of versions.querySelectorAll("button")) {
      item.disabled = locked || item.getAttribute("aria-current") === "true";
    }
    zoomOut.disabled = locked || camera.zoom === 1;
    zoomIn.disabled = locked || !hasFile() || camera.zoom >= 5;
    fit.disabled = locked || camera.zoom === 1;
    fit.textContent = `${Math.round(camera.zoom * 100)}%`;
    find("drawingBrush").hidden = tool !== "erase";
    brush.disabled = locked || !ready;
    find("drawingCropActions").hidden = tool !== "crop" || !crop;
    applyCrop.disabled = !ready || !crop || !validCrop(crop);
    canvas.dataset.editTool = !gesture && !ready && tool !== "pan" ? "" : tool;
    const message = current.edits.length >= MAX_EDITS
      ? "Bản này đã đạt giới hạn chỉnh sửa. Bạn vẫn có thể khôi phục một phiên bản trước."
      : {
          crop: crop ? "Kéo góc để chỉnh khung. Enter để áp dụng, Esc để hủy." : "Kéo để chọn vùng muốn giữ.",
          erase: "Kéo trên nét cần tẩy.",
          stroke: "Bấm vào nét đang được tô xanh để xóa cả nét.",
          pan: "Kéo để di chuyển khung nhìn.",
        }[tool] ?? "";
    if (status.textContent !== message) status.textContent = message;
  }

  function renderHistory() {
    const initial = { label: "Bản chưa chỉnh", at: null, edits: [] };
    versions.replaceChildren();
    const entries = [...archive].reverse();
    if (current.at && !entries.includes(current)) entries.unshift(current);
    for (const version of [...entries, initial]) {
      const button = document.createElement("button");
      const selected = version === current || (!version.at && !current.at);
      button.type = "button";
      button.setAttribute("aria-current", String(selected));
      button.disabled = selected || isLocked();
      const time = version.at && new Date(version.at).toLocaleTimeString("vi-VN", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      button.textContent = time ? `${version.label} · ${time}` : version.label;
      if (selected) button.textContent += " · Hiện tại";
      button.onclick = () => {
        if (isLocked()) return;
        checkpoint(version.edits, "Khôi phục phiên bản");
        history.open = false;
        history.querySelector("summary").focus();
      };
      versions.append(button);
    }
  }

  function clearGesture() {
    const pointer = gesture?.id;
    gesture = null;
    if (pointer !== undefined && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    crop = null;
    overlay = null;
  }

  function updateVersion() {
    clearGesture();
    renderHistory();
    onEdit(activePaths());
  }

  function checkpoint(edits, label) {
    past = [...past.slice(1 - KEEP_VERSIONS), current];
    future = [];
    current = { label, at: Date.now(), edits };
    archive = [...archive.slice(1 - KEEP_VERSIONS), current];
    updateVersion();
  }

  function perform(edit) {
    if (!editable() || current.edits.length >= MAX_EDITS) return;
    const paths = activePaths();
    const result = applyEdits(paths, [edit]);
    if (JSON.stringify(paths) === JSON.stringify(result)) {
      clearGesture();
      onStateChange();
      redraw();
      return;
    }
    checkpoint([...current.edits, edit], names[edit.type]);
  }

  function step(backward) {
    if (isLocked()) return;
    const from = backward ? past : future;
    if (!from.length) return;
    (backward ? future : past).push(current);
    current = from.pop();
    updateVersion();
  }

  function choose(name) {
    clearGesture();
    tool = name;
    if (tool && tool !== "pan") selectPaths();
    onStateChange();
    redraw();
  }

  function setZoom(zoom) {
    camera.zoom = clamp(zoom, 1, 5);
    if (camera.zoom === 1) {
      camera.x = camera.y = 0;
      if (tool === "pan") tool = "";
    }
    sync();
    redraw();
  }

  function toPoint(event, constrain = false) {
    const area = getArea();
    const rect = canvas.getBoundingClientRect();
    const { k, left, top } = canvasTransform(canvas, area, camera);
    if (k <= 0) return null;
    const x = (event.clientX - rect.left - left) / k;
    const y = area.h - (event.clientY - rect.top - top) / k;
    if (!constrain && (x < 0 || y < 0 || x > area.w || y > area.h)) return null;
    return {
      x: clamp(Math.round(x * 1000) / 1000, 0, area.w),
      y: clamp(Math.round(y * 1000) / 1000, 0, area.h),
    };
  }

  function cropAnchor(point) {
    if (!crop) return point;
    const { k } = canvasTransform(canvas, getArea(), camera);
    for (const x of ["min", "max"]) for (const y of ["min", "max"]) {
      if (pointDistance(point, { x: crop[x].x, y: crop[y].y }) * k <= 12) {
        return { x: crop[x === "min" ? "max" : "min"].x, y: crop[y === "min" ? "max" : "min"].y };
      }
    }
    return point;
  }

  const validCrop = ({ min, max }) => max.x - min.x >= 0.1 && max.y - min.y >= 0.1;
  const radius = () => Number(brush.value) / 2;

  function cursor(point) {
    if (tool === "erase") overlay = { type: "erase", point, points: gesture?.points, radius: gesture?.radius ?? radius() };
    if (tool === "stroke") {
      const paths = activePaths();
      overlay = { type: "stroke", path: paths[nearestStroke(paths, point)] };
    }
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!tool || event.button !== 0 || !event.isPrimary || isLocked()) return;
    if (tool !== "pan" && !editable()) return;
    const point = toPoint(event);
    if (tool !== "pan" && !point) return;
    canvas.focus({ preventScroll: true });
    event.preventDefault();
    if (tool === "stroke") { perform({ type: "stroke", point }); return; }
    gesture = { id: event.pointerId, start: point, cx: event.clientX, cy: event.clientY };
    if (tool === "crop") gesture.start = cropAnchor(point);
    if (tool === "erase") Object.assign(gesture, { points: [point], radius: radius() });
    if (tool === "pan") Object.assign(gesture, { x: camera.x, y: camera.y });
    canvas.setPointerCapture(event.pointerId);
    onStateChange();
  });

  function move(event) {
    if (!tool || !event.isPrimary || isLocked()) return;
    if (gesture && gesture.id !== event.pointerId) return;
    const point = toPoint(event, Boolean(gesture));
    if (gesture && tool === "pan") {
      const { width, height, k } = canvasTransform(canvas, getArea(), camera);
      const area = getArea();
      const limitX = Math.max(0, (width + area.w * k) / 2 - 48);
      const limitY = Math.max(0, (height + area.h * k) / 2 - 48);
      camera.x = clamp(gesture.x + event.clientX - gesture.cx, -limitX, limitX);
      camera.y = clamp(gesture.y + event.clientY - gesture.cy, -limitY, limitY);
    } else if (editable() && point) {
      if (gesture && tool === "crop") overlay = crop = rectangle(gesture.start, point);
      if (gesture && tool === "erase" && pointDistance(gesture.points.at(-1), point) >= 0.12) {
        if (gesture.points.length === MAX_BRUSH_POINTS) {
          gesture.points = gesture.points.filter((_, i) => i % 2 === 0 || i === MAX_BRUSH_POINTS - 1);
        }
        gesture.points.push(point);
      }
      cursor(point);
    } else if (tool !== "crop") overlay = null;
    redraw();
  }

  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", (event) => {
    if (gesture?.id !== event.pointerId) return;
    move(event);
    const finished = gesture;
    gesture = null;
    if (tool === "erase") {
      overlay = null;
      perform({ type: "erase", points: finished.points, radius: finished.radius });
    }
    if (tool === "crop" && crop && !validCrop(crop)) crop = overlay = null;
    onStateChange();
    redraw();
  });
  canvas.addEventListener("pointercancel", () => { clearGesture(); onStateChange(); redraw(); });
  canvas.addEventListener("pointerleave", () => {
    if (!gesture && tool !== "crop") { overlay = null; redraw(); }
  });

  tools.forEach((button) => {
    button.onclick = () => choose(tool === button.dataset.editTool ? "" : button.dataset.editTool);
  });
  brush.oninput = () => { find("drawingBrushValue").value = `${brush.value} mm`; };
  undo.onclick = () => step(true);
  redo.onclick = () => step(false);
  zoomOut.onclick = () => setZoom(camera.zoom / 1.25);
  zoomIn.onclick = () => setZoom(camera.zoom * 1.25);
  fit.onclick = () => setZoom(1);
  applyCrop.onclick = () => { if (crop && validCrop(crop)) perform(crop); };
  find("drawingCancelCrop").onclick = () => { clearGesture(); onStateChange(); redraw(); };

  function keydown(event) {
    if (isLocked()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      step(!event.shiftKey);
    } else if (event.key === "Escape" && tool) {
      event.preventDefault();
      choose("");
    } else if (event.target === canvas && event.key === "Enter" && crop && validCrop(crop)) {
      event.preventDefault();
      perform(crop);
    }
  }
  canvas.addEventListener("keydown", keydown);
  root.addEventListener("keydown", keydown);

  reset();
  return {
    reset, sync, currentEdits,
    get camera() { return camera; },
    get overlay() { return overlay; },
    get busy() { return Boolean(gesture || crop); },
    snapshot: () => ({ current, past: [...past], future: [...future], archive: [...archive] }),
    cancel: () => choose(""),
    cancelPending: clearGesture,
  };
}
