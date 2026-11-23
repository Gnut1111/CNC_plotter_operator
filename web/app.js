import { paintPreview, readMoves } from "./preview.js";

// Pixel2Plot Operator — web client (ES module thuần, chạy thẳng trên trình duyệt)
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STATUS_VI = {
  QUEUED: "Hàng đợi", SENDING: "Đang truyền", READY: "Sẵn sàng", DRAWING: "Đang vẽ", PAUSED: "Tạm dừng",
  COMPLETED: "Hoàn thành", CANCELLED: "Đã hủy", FAILED: "Lỗi",
  IDLE: "Sẵn sàng", OFFLINE: "Mất kết nối", RECEIVING: "Nhận file", HOMING: "Về gốc", ERROR: "Lỗi máy", BOOT: "Khởi động",
};
const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS_VI[s] || s)}</span>`;

const app = {
  token: localStorage.getItem("token"),
  user: JSON.parse(localStorage.getItem("user") || "null"),
  machines: [], selectedMachine: null, ws: null,
};

// ---------------- API ----------------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = app.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (res.status === 401 && path !== "/auth/login") {
    if (token === app.token) logout();
    throw new Error("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");
  }
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(body.error || `Lỗi máy chủ (HTTP ${res.status})`), { status: res.status });
  return body;
}

// ---------------- Notification UI ----------------
function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4500);
}

// ---------------- Auth View ----------------
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#loginError").textContent = "";
  try {
    const r = await api("/auth/login", { method: "POST", json: { username: f.get("username"), password: f.get("password") } });
    app.token = r.token; app.user = r.user;
    localStorage.setItem("token", r.token); localStorage.setItem("user", JSON.stringify(r.user));
    enterApp();
  } catch (err) { $("#loginError").textContent = err.message; }
});

function logout() {
  app.token = null; app.user = null;
  localStorage.removeItem("token"); localStorage.removeItem("user");
  app.ws?.close();
  app.ws = null;
  setConnection(false, "Đang kết nối");
  app.machines = [];
  app.selectedMachine = null;
  $("#machinePick").replaceChildren();
  $("#allJobs").checked = false;
  $("#jobDetails").close();
  $("#jobRows").replaceChildren();
  $$("#admMachines, #admUsers, #admQueue").forEach((table) => table.replaceChildren());
  resetWorkspace();
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
}
$("#logoutBtn").onclick = logout;

function enterApp() {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#whoami").textContent = `${app.user.username} (${app.user.role === "admin" ? "Quản trị" : "Người dùng"})`;
  $$(".admin-only").forEach((el) => el.classList.toggle("hidden", app.user.role !== "admin"));
  connectWs();
  loadMachines().catch((err) => toast(err.message, "err"));
  showTab("draw");
}

// ---------------- Tabs ----------------
function showTab(name) {
  $$("#tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $$(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${name}`));
  if (name === "jobs") loadJobs().catch((err) => toast(err.message, "err"));
  if (name === "machines") loadMachines().catch((err) => toast(err.message, "err"));
  if (name === "admin") loadAdmin().catch((err) => toast(err.message, "err"));
  if (name === "draw") drawPreview();
}
$$("#tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------------- Drawing workspace ----------------
const form = $("#convertForm");
const canvas = $("#preview");
const fileInput = $("#sourceFile");
const MODE_VI = { centerline: "Đường tâm", outline: "Đường viền", fill: "Viền + gạch" };
const METHOD_VI = { otsu: "Tự động (Otsu)", adaptive: "Thích nghi", fixed: "Thủ công" };
const MAX_FILE_SIZE = 5 * 1024 * 1024;
let file, original, originalUrl, preview, displayed, previewTimer, previewRequest, tuneRequest;
const TUNE_LABELS = { fast: "Nhanh", detail: "Chi tiết" };
let revision = 0, savedDrawingId, sentJob, activeJob = null, sending = false, showImage = false;

function workArea() {
  const machine = app.machines.find((m) => m.id === app.selectedMachine);
  return machine ? { w: machine.work_width, h: machine.work_height } : { w: 200, h: 200 };
}

function readParams() {
  const tm = form.thresholdMode.value;
  const p = {
    widthMm: +form.widthMm.value, heightMm: +form.heightMm.value, detail: +form.detail.value,
    threshold: tm === "manual" ? +form.threshold.value : tm,
    invert: form.invert.value, mode: form.mode.value, smoothing: +form.smoothing.value,
    despeckle: form.despeckle.checked, penWidthMm: +form.penWidthMm.value,
    drawFeed: +form.drawFeed.value, travelFeed: +form.travelFeed.value,
    penUp: form.penUp.value.trim(), penDown: form.penDown.value.trim(),
  };
  p.simplifyMm = form.simplifyMm.value ? +form.simplifyMm.value : null;
  p.hatchRatio = +form.hatchRatio.value;
  p.fillStrategy = form.fillStrategy.value;
  p.rasterPx = form.rasterPx.value ? +form.rasterPx.value : null;
  return p;
}

function uploadData(params, machineId) {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("params", JSON.stringify(params));
  if (machineId) fd.append("machineId", machineId);
  return fd;
}

function selectView(image) {
  showImage = image;
  drawPreview();
  syncActions();
}

function drawPreview() {
  const area = workArea();
  const size = {
    w: Math.min(+form.widthMm.value || area.w, area.w),
    h: Math.min(+form.heightMm.value || area.h, area.h),
  };
  paintPreview(canvas, { area, size, image: original, preview: displayed, showImage, showTravel: $("#showTravel").checked });
  const hasFile = Boolean(file);
  const emptyEl = $("#emptyPreview");
  if (emptyEl) {
    emptyEl.hidden = hasFile;
    emptyEl.classList.toggle("hidden", hasFile);
  }
  canvas.setAttribute("aria-label", showImage ? "Ảnh gốc trong vùng vẽ" : "Đường vẽ theo tọa độ máy");
}

function updateStepper() {
  const s1 = $("#stepIndicator1"), s2 = $("#stepIndicator2"), s3 = $("#stepIndicator3"), s4 = $("#stepIndicator4");
  if (!s1) return;
  [s1, s2, s3, s4].forEach((s) => s.classList.remove("active"));
  if (sentJob || activeJob) {
    s4.classList.add("active");
  } else if (preview && app.selectedMachine) {
    s3.classList.add("active");
  } else if (file) {
    s2.classList.add("active");
  } else {
    s1.classList.add("active");
  }
}

function updateStepGuide() {
  const guideText = $("#guideText");
  if (!guideText) return;
  const machine = app.machines.find((m) => m.id === app.selectedMachine);

  if (!file) {
    guideText.textContent = "Bước 1: Chọn ảnh PNG hoặc JPG để bắt đầu.";
  } else if (previewRequest || previewTimer) {
    guideText.textContent = "Bước 2: Đang tạo bản xem trước nét vẽ...";
  } else if (!preview) {
    guideText.textContent = "Chưa tạo được bản xem trước. Hãy đổi thông số hoặc chọn ảnh khác.";
  } else if (!app.selectedMachine) {
    guideText.textContent = "Bước 3: Chọn máy vẽ trong danh sách trên.";
  } else if (machine && !machine.online) {
    guideText.textContent = `Máy ${machine.name} đang mất kết nối. Lệnh gửi sẽ nằm trong hàng đợi.`;
  } else if (sending) {
    guideText.textContent = "Đang truyền dữ liệu G-code sang máy...";
  } else if (sentJob) {
    guideText.textContent = `Bước 4: Đã gửi phiên #${sentJob.id} vào ${sentJob.machine_name}. Theo dõi tiến độ bên dưới.`;
  } else {
    guideText.textContent = `Sẵn sàng gửi bản vẽ tới ${machine?.name || "máy"}.`;
  }
}

function syncActions() {
  $("#pathsView").disabled = !file;
  $("#imageView").disabled = !original?.naturalWidth;
  $("#pathsView").setAttribute("aria-pressed", String(!showImage));
  $("#imageView").setAttribute("aria-pressed", String(showImage));
  $("#showTravel").disabled = showImage || !displayed;
  $("#downloadBtn").disabled = !preview;
  $("#gcodeDetails").classList.toggle("hidden", !preview);

  const canSend = Boolean(preview) && Boolean(app.selectedMachine) && !sending && !sentJob && !tuneRequest;
  $("#sendBtn").disabled = !canSend;
  $("#sendBtn").querySelector(".btn-text").textContent = sending ? "Đang gửi…" : sentJob ? `Đã gửi #${sentJob.id}` : "Gửi bản vẽ";
  $("#showSentJob").classList.toggle("hidden", !sentJob);
  form.inert = sending;
  fileInput.disabled = sending;
  if ($("#machineSelect")) $("#machineSelect").disabled = sending;
  $$("[data-tune]").forEach((button) => {
    const profile = button.dataset.tune;
    button.disabled = !file || !form.checkValidity() || Boolean(tuneRequest);
    button.textContent = tuneRequest?.profile === profile ? "Đang tìm…" : TUNE_LABELS[profile];
  });

  updateStepper();
  updateStepGuide();
  renderActiveJobBar();
}

function renderActiveJobBar() {
  const bar = $("#activeJobBar");
  if (!bar) return;
  const current = sentJob || (activeJob && ["QUEUED", "SENDING", "READY", "DRAWING", "PAUSED"].includes(activeJob.status) ? activeJob : null);
  if (!current) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  $("#activeJobTitle").textContent = `Phiên #${current.id}: ${current.drawing_name || "Bản vẽ"} (${current.machine_name || current.machine_id})`;
  $("#activeJobBadge").innerHTML = badge(current.status);
  const pct = Number(current.progress) || 0;
  $("#activeJobBarFill").style.width = `${pct}%`;
  $("#activeJobPercent").textContent = `${pct}%`;

  const btn = (act, label, cls = "") => `<button type="button" class="small ${cls}" data-quick-job="${current.id}" data-act="${act}">${label}</button>`;
  const actions = [
    current.status === "DRAWING" && btn("pause", "Tạm dừng"),
    current.status === "PAUSED" && btn("resume", "Tiếp tục"),
    !["COMPLETED", "CANCELLED", "FAILED"].includes(current.status) && btn("cancel", "Hủy", "danger"),
    `<button type="button" class="small ghost" data-quick-job="${current.id}" data-act="details">Chi tiết</button>`,
  ].filter(Boolean).join(" ");
  $("#activeJobActions").innerHTML = actions;
}

$("#activeJobBar")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-quick-job]");
  if (!btn) return;
  const id = Number(btn.dataset.quickJob);
  const act = btn.dataset.act;
  if (act === "details") {
    openJobDetails(id);
    return;
  }
  btn.disabled = true;
  try {
    const { job } = await api(`/jobs/${id}/${act}`, { method: "POST" });
    if (sentJob && sentJob.id === id) sentJob = job;
    if (activeJob && activeJob.id === id) activeJob = job;
    renderActiveJobBar();
    replaceJobRow(job);
    toast(`Phiên #${id}: Đã gửi lệnh ${act === "pause" ? "tạm dừng" : act === "resume" ? "tiếp tục" : "hủy"}`, "ok");
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

function clearTuneResult() {
  tuneRequest?.controller.abort();
  tuneRequest = null;
  $("#autoResult").replaceChildren();
}

function schedulePreview({ delay = 260, keepTuneResult = false, keepImage = false } = {}) {
  const current = ++revision;
  clearTimeout(previewTimer);
  previewTimer = null;
  previewRequest?.abort();
  previewRequest = null;
  if (!keepTuneResult) clearTuneResult();
  preview = null;
  if (!keepImage || !form.checkValidity()) displayed = null;
  savedDrawingId = null;
  sentJob = null;
  $("#stats").textContent = "";
  $("#gcodeText").textContent = "";
  $("#gcodeDetails").open = false;
  $("#sendMsg").textContent = "";
  $("#retryPreview").classList.add("hidden");
  syncActions();
  drawPreview();
  if (!file) { $("#convertMsg").textContent = ""; return; }
  if (!form.checkValidity()) {
    const invalid = form.querySelector(":invalid");
    const label = invalid?.labels?.[0]?.childNodes[0]?.textContent.trim() || "Thông số";
    const problem = invalid?.validity.rangeUnderflow ? `nhập từ ${invalid.min} trở lên.`
      : invalid?.validity.rangeOverflow ? `nhập tối đa ${invalid.max}.`
      : invalid?.validity.stepMismatch ? `nhập theo bước ${invalid.step}.`
      : invalid?.validity.patternMismatch ? "tối đa 20 ký tự gồm chữ, số, dấu cách, chấm và gạch ngang."
      : "nhập giá trị hợp lệ.";
    $("#convertMsg").textContent = `${label}: ${problem}`;
    return;
  }
  $("#convertMsg").textContent = displayed ? "Đang cập nhật…" : "Đang tạo bản xem trước…";
  previewTimer = setTimeout(() => {
    previewTimer = null;
    runPreview(current);
  }, delay);
}

async function runPreview(current) {
  const controller = new AbortController();
  previewRequest = controller;
  const params = readParams(), machineId = app.selectedMachine;
  try {
    const result = await api("/drawings/preview", { method: "POST", body: uploadData(params, machineId), signal: controller.signal });
    if (current !== revision) return;
    preview = { ...result, requestParams: params, moves: readMoves(result.gcode, result.params) };
    displayed = preview;
    const { stats: s } = result;
    const [left, bottom, right, top] = s.bbox;
    $("#stats").textContent = [
      `${Number((right - left).toFixed(1))} × ${Number((top - bottom).toFixed(1))} mm`,
      `${s.paths} nét`, `ước tính ~${s.minutes} phút`, `độ khớp ${s.iou}%`,
      `tách nét: ${METHOD_VI[s.binarize.method] || s.binarize.method}`,
    ].join(" · ");
    $("#gcodeText").textContent = result.gcode.length > 200000 ? result.gcode.slice(0, 200000) + "\n…" : result.gcode;
    $("#convertMsg").textContent = "Bản xem trước sẵn sàng.";
    drawPreview();
  } catch (err) {
    if (current !== revision || err.name === "AbortError") return;
    displayed = null;
    drawPreview();
    $("#convertMsg").textContent = `Lỗi: ${err.message}. Thử đổi kiểu nét hoặc ảnh khác.`;
    $("#retryPreview").classList.remove("hidden");
  } finally {
    if (current === revision) {
      previewRequest = null;
      syncActions();
    }
  }
}

function releaseOriginal() {
  original = null;
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  originalUrl = null;
}

function updateFormLabels() {
  $("#detailVal").textContent = form.detail.value;
  $("#thresholdVal").textContent = form.threshold.value;
  $("#thresholdRow").classList.toggle("hidden", form.thresholdMode.value !== "manual");
}

function resetWorkspace() {
  releaseOriginal();
  file = null;
  fileInput.value = "";
  form.reset();
  updateFormLabels();
  showImage = false;
  sending = false;
  activeJob = null;
  sentJob = null;
  $("#showTravel").checked = false;
  $("#fileInfo").textContent = "PNG hoặc JPG · tối đa 5 MB";
  $("#fileError").hidden = true;
  const emptyEl = $("#emptyPreview");
  if (emptyEl) {
    emptyEl.hidden = false;
    emptyEl.classList.remove("hidden");
  }
  schedulePreview();
}

function handleSelectedFile(newFile) {
  releaseOriginal();
  file = newFile;
  showImage = false;
  const error = $("#fileError");
  const message = file && (!["image/png", "image/jpeg"].includes(file.type)
    ? "Định dạng không hỗ trợ. Chọn ảnh PNG hoặc JPG."
    : file.size > MAX_FILE_SIZE ? "File vượt quá 5 MB. Chọn ảnh nhỏ hơn." : "");
  error.textContent = message || "";
  error.hidden = !message;
  if (message) { fileInput.value = ""; file = null; }
  $("#fileInfo").textContent = file ? file.name : "PNG hoặc JPG · tối đa 5 MB";
  if (file) {
    originalUrl = URL.createObjectURL(file);
    const image = new Image();
    original = image;
    image.onload = () => { if (image === original) { drawPreview(); syncActions(); } };
    image.src = originalUrl;
  }
  schedulePreview({ delay: 0 });
}

fileInput.addEventListener("change", () => {
  handleSelectedFile(fileInput.files[0]);
});

// Drag & drop support on viewport
const dropZone = $("#dropZone");
if (dropZone) {
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const droppedFile = e.dataTransfer?.files?.[0];
    if (droppedFile) {
      handleSelectedFile(droppedFile);
    }
  });
}

form.addEventListener("input", (event) => {
  if (event.target === fileInput) return;
  updateFormLabels();
  schedulePreview({ keepImage: true });
});
form.addEventListener("submit", (event) => { event.preventDefault(); });
$("#resetSettings").onclick = () => {
  for (const control of form.querySelectorAll("input, select")) {
    if (control instanceof HTMLSelectElement) {
      control.selectedIndex = [...control.options].findIndex((option) => option.defaultSelected);
      if (control.selectedIndex < 0) control.selectedIndex = 0;
    } else if (control.type === "checkbox") control.checked = control.defaultChecked;
    else control.value = control.defaultValue;
  }
  updateFormLabels();
  machineChanged();
};
$("#pathsView").onclick = () => selectView(false);
$("#imageView").onclick = () => selectView(true);
$("#showTravel").onchange = drawPreview;
$("#retryPreview").onclick = () => schedulePreview({ delay: 0 });
new ResizeObserver(drawPreview).observe(canvas.parentElement);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawPreview);

$$("[data-tune]").forEach((button) => {
  button.onclick = () => tuneDrawing(button.dataset.tune);
});

async function tuneDrawing(profile) {
  if (tuneRequest || sending) return;
  const controller = new AbortController();
  const request = { controller, profile };
  tuneRequest = request;
  const panel = $("#autoResult");
  panel.textContent = `Đang tìm cấu hình ${TUNE_LABELS[profile]}. Tối đa ${profile === "fast" ? 15 : 45} giây.`;
  syncActions();
  try {
    const body = uploadData(readParams(), app.selectedMachine);
    body.append("profile", profile);
    const result = await api("/drawings/auto", {
      method: "POST", body, signal: controller.signal,
    });
    if (tuneRequest !== request) return;
    const [{ params, metrics }] = result.candidates;
    form.detail.value = params.detail;
    form.mode.value = params.mode;
    form.smoothing.value = params.smoothing;
    form.simplifyMm.value = params.simplifyMm ?? "";
    form.hatchRatio.value = params.hatchRatio;
    form.fillStrategy.value = params.fillStrategy;
    form.rasterPx.value = params.rasterPx ?? "";
    form.despeckle.checked = params.despeckle;
    form.penUp.value = params.penUp;
    form.penDown.value = params.penDown;
    form.thresholdMode.value = params.threshold === "adaptive" ? "adaptive" : "manual";
    if (params.threshold !== "adaptive") form.threshold.value = params.threshold;
    form.invert.value = String(params.invert);
    updateFormLabels();
    showImage = false;
    const number = (value) => value.toLocaleString("vi-VN", { maximumFractionDigits: 1 });
    panel.innerHTML = `<div class="cand">
      <b>${TUNE_LABELS[profile]} · ${MODE_VI[params.mode]}</b>
      <small>Trùng diện tích nét ${number(metrics.iou)}% · ước tính vẽ ${number(metrics.minutes)} phút</small>
      <small>Tìm trong ${number(result.ms / 1000)} giây · kiểm tra kỹ ${result.verified}/${result.tried} cấu hình</small>
      ${result.timeLimited ? "<small>Đã hết thời gian tìm. Dùng kết quả tốt nhất đã kiểm tra.</small>" : ""}
    </div>`;
    schedulePreview({ delay: 0, keepTuneResult: true, keepImage: true });
  } catch (err) {
    if (tuneRequest === request) panel.textContent = err.message;
  } finally {
    if (tuneRequest === request) { tuneRequest = null; syncActions(); }
  }
}

$("#downloadBtn").onclick = () => {
  if (!preview) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([preview.gcode], { type: "text/plain" }));
  link.download = (file ? file.name.replace(/\.[^.]+$/, "") : "drawing") + ".gcode";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

$("#showSentJob").onclick = () => showTab("jobs");
$("#sendBtn").onclick = async () => {
  if (sending || tuneRequest || sentJob || !preview || !app.selectedMachine) return;
  const current = revision;
  const token = app.token;
  const machineId = app.selectedMachine;
  const { previewHash, requestParams } = preview;
  sending = true;
  $("#sendMsg").textContent = "Đang truyền bản vẽ sang máy...";
  syncActions();
  try {
    let drawingId = savedDrawingId;
    if (!drawingId) {
      const body = uploadData(requestParams, machineId);
      body.append("previewHash", previewHash);
      const result = await api("/drawings", { method: "POST", body });
      if (app.token !== token) return;
      drawingId = result.drawing.id;
      if (current === revision) savedDrawingId = drawingId;
    }
    const { job } = await api("/jobs", { method: "POST", json: { drawingId, machineId } });
    if (current === revision) {
      sentJob = job;
      activeJob = job;
      $("#sendMsg").textContent = `Phiên #${job.id} đã vào hàng đợi của ${job.machine_name}.`;
    } else if (app.token === token) {
      toast(`Phiên #${job.id} đã vào hàng đợi của ${job.machine_name}.`, "ok");
    }
  } catch (err) {
    if (current === revision) {
      if (err.status === 409 && !savedDrawingId) {
        $("#sendMsg").textContent = "Bản xem trước đã thay đổi. Đang cập nhật...";
        await loadMachines().catch(() => {});
        if (app.token !== token) return;
        schedulePreview({ delay: 0 });
      } else {
        $("#sendMsg").textContent = `Lỗi gửi: ${err.message}`;
      }
    }
    else if (app.token === token) toast(err.message, "err");
  } finally {
    if (app.token === token) { sending = false; syncActions(); }
  }
};

// ---------------- Machine Selector ----------------
async function loadMachines() {
  const token = app.token;
  const previous = app.selectedMachine;
  const area = workArea();
  const { machines } = await api("/machines");
  if (token !== app.token) return;
  app.machines = machines;
  if (!machines.some((m) => m.id === app.selectedMachine)) {
    const online = machines.filter((m) => m.online);
    app.selectedMachine = (online.length === 1 ? online[0] : machines.length === 1 ? machines[0] : null)?.id ?? null;
  }
  renderMachinePick();
  renderMachineCards();
  if (previous !== app.selectedMachine || area.w !== workArea().w || area.h !== workArea().h) machineChanged();
}

function machineChanged() {
  const { w, h } = workArea();
  form.widthMm.max = w;
  form.heightMm.max = h;
  if (+form.widthMm.value > w) form.widthMm.value = w;
  if (+form.heightMm.value > h) form.heightMm.value = h;
  schedulePreview();
}

function renderMachinePick() {
  const container = $("#machinePick");
  if (!container) return;
  if (!app.machines.length) {
    container.innerHTML = '<p class="muted">Chưa có máy vẽ trong hệ thống.</p>';
    return;
  }
  container.innerHTML = `
    <label>Máy nhận lệnh
      <select id="machineSelect">
        <option value="" disabled ${app.selectedMachine ? "" : "selected"}>Chọn máy nhận</option>
        ${app.machines.map((m) => `<option value="${esc(m.id)}" ${app.selectedMachine === m.id ? "selected" : ""}>${esc(m.name)} · ${esc(m.id)} (${m.online ? "Online" : "Offline"})</option>`).join("")}
      </select>
    </label>
    <div id="machineInfo"></div>`;
  $("#machineSelect").onchange = (event) => {
    app.selectedMachine = event.target.value;
    renderMachineInfo();
    machineChanged();
  };
  renderMachineInfo();
  syncActions();
}

function renderMachineInfo() {
  const info = $("#machineInfo");
  if (!info) return;
  const m = app.machines.find((machine) => machine.id === app.selectedMachine);
  info.innerHTML = m ? `
    <div class="machine-meta">
      <span>Vùng vẽ: <strong>${m.work_width} × ${m.work_height} mm</strong></span>
      ${badge(m.state)}
    </div>
    ${m.online ? "" : '<p class="muted option-hint error">Máy đang mất kết nối. Lệnh gửi sẽ chờ trong hàng đợi.</p>'}`
    : '<p class="muted option-hint">Chọn máy vẽ để tiếp tục.</p>';
}

function renderMachineCards() {
  const container = $("#machineCards");
  if (!container) return;
  container.innerHTML = app.machines.map((m) => `
    <div class="card">
      <div class="pane-title pane-title-actions">
        <h2>${esc(m.name)}</h2>
        ${badge(m.state)}
      </div>
      <div class="pane-body">
        <p class="muted">
          Mã thiết bị: <code>${esc(m.id)}</code><br/>
          Vùng vẽ: <strong>${m.work_width} × ${m.work_height} mm</strong><br/>
          Hàng đợi: <strong>${m.queued}</strong><br/>
          Tín hiệu cuối: ${m.last_seen ? new Date(m.last_seen).toLocaleTimeString("vi-VN") : "—"}
        </p>
      </div>
    </div>`).join("");
}

// ---------------- Job List + Job Control ----------------
let jobsRequest = 0;
const pendingJobActions = new Set();
const jobsBody = $("#jobRows");
const jobDetails = $("#jobDetails");

async function loadJobs() {
  const request = ++jobsRequest, token = app.token;
  const all = $("#allJobs").checked ? "?all=1" : "";
  const { jobs } = await api(`/jobs${all}`);
  if (request !== jobsRequest || token !== app.token) return;
  jobsBody.innerHTML = jobs.map(jobRow).join("") || `<tr><td colspan="8" class="muted" style="text-align:center;padding:20px;">Chưa có phiên vẽ nào.</td></tr>`;
}

$("#allJobs").onchange = () => loadJobs().catch((err) => toast(err.message, "err"));

function jobRow(j) {
  const btn = (action, label, cls = "") => `<button class="small ${cls}" data-job="${j.id}" data-act="${action}" ${pendingJobActions.has(j.id) ? "disabled" : ""}>${label}</button>`;
  const actions = [
    j.status === "DRAWING" && btn("pause", "Tạm dừng"),
    j.status === "PAUSED" && btn("resume", "Tiếp tục"),
    !["COMPLETED", "CANCELLED", "FAILED"].includes(j.status) && btn("cancel", "Hủy", "danger"),
  ].filter(Boolean).join(" ");
  const progress = Number(j.progress) || 0;
  return `<tr id="job-${j.id}">
    <td class="col-id tabular-nums">${j.id}</td>
    <td class="col-name"><button class="job-name" type="button" data-details="${j.id}">${esc(j.drawing_name)}</button><small class="job-ref">#${j.id} · ${esc(j.machine_name)}</small></td>
    <td class="col-mach">${esc(j.machine_name)}</td>
    <td class="col-user">${esc(j.username)}</td>
    <td class="col-status">${badge(j.status)}${j.error ? `<br/><small class="error">${esc(j.error)}</small>` : ""}</td>
    <td class="col-progress"><div class="bar"><span style="width:${progress}%"></span></div><small class="tabular-nums">${progress}%</small></td>
    <td class="col-time"><small class="tabular-nums">${formatDate(j.created_at)}</small></td>
    <td class="col-actions"><div class="job-actions">${actions}</div></td>
  </tr>`;
}

function formatDate(value) {
  return new Date(value.endsWith("Z") ? value : value + "Z").toLocaleString("vi-VN");
}

let detailsRequest = 0;
async function openJobDetails(id) {
  const request = ++detailsRequest;
  const body = $("#jobDetailsBody");
  $("#jobDetailsTitle").textContent = `Phiên vẽ #${id}`;
  body.textContent = "Đang tải chi tiết…";
  jobDetails.showModal();
  try {
    const { job, events } = await api(`/jobs/${id}`);
    if (request !== detailsRequest || !jobDetails.open) return;
    body.innerHTML = `
      <div style="margin-bottom:10px;">
        <h3 style="font-size:14px;margin-bottom:4px;">${esc(job.drawing_name)}</h3>
        <div style="display:flex;gap:6px;align-items:center;">
          ${badge(job.status)}
          <span class="muted">${esc(job.machine_name)} · Người gửi: ${esc(job.username)}</span>
        </div>
      </div>
      <p class="muted" style="font-size:11px;">Tạo lúc: <span class="tabular-nums">${formatDate(job.created_at)}</span></p>
      <h3 style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px;font-size:12px;">Nhật ký sự kiện</h3>
      ${events.length ? `<ol class="job-events">${events.map((event) => `<li><time class="tabular-nums">${formatDate(event.created_at)}</time>
        <span>${esc(STATUS_VI[event.event] || event.event)}${event.detail ? ` · ${esc(event.detail)}` : ""}</span></li>`).join("")}</ol>`
      : '<p class="muted">Chưa có sự kiện ghi nhận.</p>'}`;
  } catch (err) {
    if (request === detailsRequest && jobDetails.open) body.textContent = `Lỗi: ${err.message}`;
  }
}

jobsBody.addEventListener("click", async (event) => {
  const details = event.target.closest("button[data-details]");
  if (details) { openJobDetails(details.dataset.details); return; }
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  const id = Number(button.dataset.job);
  if (pendingJobActions.has(id)) return;
  pendingJobActions.add(id);
  button.closest("tr").querySelectorAll("[data-act]").forEach((action) => { action.disabled = true; });
  let updated;
  try { ({ job: updated } = await api(`/jobs/${id}/${button.dataset.act}`, { method: "POST" })); }
  catch (err) { toast(err.message, "err"); }
  finally {
    pendingJobActions.delete(id);
    if (updated) {
      replaceJobRow(updated);
      if (sentJob?.id === id) sentJob = updated;
      if (activeJob?.id === id) activeJob = updated;
      renderActiveJobBar();
    }
    else $(`#job-${id}`)?.querySelectorAll("[data-act]").forEach((action) => { action.disabled = false; });
  }
});

function replaceJobRow(job) {
  const row = $(`#job-${job.id}`);
  if (!row) return false;
  const focus = row.contains(document.activeElement) ? document.activeElement : null;
  row.outerHTML = jobRow(job);
  if (focus) {
    const newRow = $(`#job-${job.id}`);
    const action = [...newRow.querySelectorAll("[data-act]")].find((button) => button.dataset.act === focus.dataset.act && !button.disabled);
    (action || newRow.querySelector("[data-details]")).focus({ preventScroll: true });
  }
  return true;
}

// ---------------- Admin Dashboard ----------------
async function loadAdmin() {
  if (app.user?.role !== "admin") return;
  const token = app.token;
  const [{ machines }, { users }, { jobs }] = await Promise.all([api("/admin/machines"), api("/admin/users"), api("/admin/queue")]);
  if (token !== app.token) return;
  $("#admMachines").innerHTML = machines.map((m) => `<tr>
    <td><code>${esc(m.id)}</code></td><td>${esc(m.name)}</td><td>${badge(m.state)}${m.enabled ? "" : " (tắt)"}</td>
    <td class="tabular-nums">${m.work_width}×${m.work_height}</td><td><code>${esc(m.token)}</code></td>
    <td><button class="small ghost" data-m="${esc(m.id)}" data-a="home">Về gốc</button>
        <button class="small ghost" data-m="${esc(m.id)}" data-a="token">Đổi token</button>
        <button class="small ${m.enabled ? "danger" : "ghost"}" data-m="${esc(m.id)}" data-a="toggle" data-en="${m.enabled}">${m.enabled ? "Tắt" : "Bật"}</button></td></tr>`).join("");
  $("#admUsers").innerHTML = users.map((u) => `<tr>
    <td class="tabular-nums">${u.id}</td><td>${esc(u.username)}</td><td><code>${u.role}</code></td><td>${u.locked ? badge("FAILED").replace("Lỗi", "Đã khóa") : badge("IDLE").replace("Sẵn sàng", "Hoạt động")}</td>
    <td><button class="small ${u.locked ? "ghost" : "danger"}" data-u="${u.id}" data-locked="${u.locked}">${u.locked ? "Mở khóa" : "Khóa"}</button></td></tr>`).join("");
  $("#admQueue").innerHTML = jobs.map((j) => `<tr><td class="tabular-nums">${j.id}</td><td><code>${esc(j.machine_id)}</code></td><td>${esc(j.drawing_name)}</td><td>${esc(j.username)}</td><td>${badge(j.status)}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted" style="text-align:center;padding:14px;">Hàng đợi toàn hệ thống đang trống.</td></tr>`;
}

$("#admMachines").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-m]");
  if (!b) return;
  try {
    if (b.dataset.a === "home") { await api(`/admin/machines/${b.dataset.m}/home`, { method: "POST" }); toast("Đã gửi lệnh về gốc", "ok"); }
    if (b.dataset.a === "token" && confirm("Cấp token mới? Máy phải cập nhật token mới mới kết nối lại được.")) {
      await api(`/admin/machines/${b.dataset.m}/token`, { method: "POST" });
      toast("Đã cấp token mới", "ok");
    }
    if (b.dataset.a === "toggle") await api(`/admin/machines/${b.dataset.m}`, { method: "PATCH", json: { enabled: b.dataset.en !== "1" } });
    loadAdmin();
  } catch (err) { toast(err.message, "err"); }
});

$("#admUsers").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-u]");
  if (!b) return;
  try { await api(`/admin/users/${b.dataset.u}`, { method: "PATCH", json: { locked: b.dataset.locked !== "1" } }); loadAdmin(); }
  catch (err) { toast(err.message, "err"); }
});

$("#addMachineForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try { const { machine } = await api("/admin/machines", { method: "POST", json: f }); toast(`Đã thêm ${machine.id}`, "ok"); e.target.reset(); loadAdmin(); loadMachines(); }
  catch (err) { toast(err.message, "err"); }
});

$("#addUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try { await api("/admin/users", { method: "POST", json: f }); toast(`Đã tạo người dùng ${f.username}`, "ok"); e.target.reset(); loadAdmin(); }
  catch (err) { toast(err.message, "err"); }
});

// ---------------- Realtime (WebSocket) ----------------
function setConnection(connected, label) {
  $("#wsDot").classList.toggle("on", connected);
  $("#wsLabel").textContent = label;
}

function connectWs(reconnecting = false) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(app.token)}`);
  app.ws = ws;
  ws.onopen = () => {
    if (app.ws !== ws) return;
    setConnection(true, "Đang đồng bộ");
    if (!reconnecting) return;
    loadMachines().catch((err) => toast(err.message, "err"));
    if (!$("#tab-jobs").classList.contains("hidden")) loadJobs().catch((err) => toast(err.message, "err"));
    if (!$("#tab-admin").classList.contains("hidden")) loadAdmin().catch((err) => toast(err.message, "err"));
  };
  ws.onclose = () => {
    if (app.ws !== ws) return;
    setConnection(false, "Mất đồng bộ");
    if (app.token && app.ws === ws) setTimeout(() => {
      if (app.token && app.ws === ws) connectWs(true);
    }, 2000);
  };
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === "machine.status") onMachineStatus(data);
    if (type === "job.status") onJobStatus(data);
    if (type === "job.completed") toast(`Phiên #${data.id} (${data.drawing_name}) đã vẽ xong`, "ok");
    if (type === "job.failed") toast(`Phiên #${data.id} lỗi: ${data.error}`, "err");
  };
}

function onMachineStatus(m) {
  const i = app.machines.findIndex((x) => x.id === m.id);
  if (i >= 0) app.machines[i] = { ...app.machines[i], ...m };
  renderMachineInfo(); renderMachineCards();
  syncActions();
  if (m.state === "OFFLINE") toast(`Máy ${m.name} mất kết nối`, "warn");
  if (m.event === "ERROR") toast(`Máy ${m.name}: ${m.error}`, "err");
  if (!$("#tab-admin").classList.contains("hidden")) loadAdmin();
}

function onJobStatus(j) {
  if (sentJob && sentJob.id === j.id) sentJob = j;
  if (!activeJob || activeJob.id === j.id || (j.machine_id === app.selectedMachine && !["COMPLETED", "CANCELLED", "FAILED"].includes(j.status))) {
    activeJob = j;
  }
  renderActiveJobBar();
  if (!replaceJobRow(j) && !$("#tab-jobs").classList.contains("hidden")) loadJobs().catch((err) => toast(err.message, "err"));
  if (!$("#tab-admin").classList.contains("hidden")) loadAdmin();
}

// ---------------- Boot ----------------
if (app.token && app.user) enterApp(); else logout();
drawPreview();
