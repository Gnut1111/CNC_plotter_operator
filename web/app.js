import { readDraft, writeDraft, deleteDraft } from "./draft.js";
import { paintPreview, playbackPosition, readMoves } from "./preview.js";
import { mountDrawingEditor } from "./edit-workspace.js";

// Pixel2Plot Operator — web client (ES module thuần, chạy thẳng trên trình duyệt)
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const machineLabel = (name) => {
  const clean = String(name || "").trim();
  if (!clean) return "máy vẽ";
  return /^máy\b/i.test(clean) ? clean : `Máy ${clean}`;
};

const STATUS_VI = {
  QUEUED: "Hàng đợi", SENDING: "Đang truyền", READY: "Sẵn sàng", DRAWING: "Đang vẽ", PAUSED: "Tạm dừng",
  COMPLETED: "Hoàn thành", CANCELLED: "Đã hủy", FAILED: "Lỗi",
  CANCEL_REQUESTED: "Chờ dừng", WAIT_PAPER: "Chờ giấy", INSPECTION: "Chờ kiểm tra giấy", IDLE: "Sẵn sàng", OFFLINE: "Mất kết nối", RECEIVING: "Nhận file", HOMING: "Về gốc", ERROR: "Lỗi máy", BOOT: "Khởi động",
};
const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS_VI[s] || s)}</span>`;

const app = {
  session: null, user: null,
  machines: [], selectedMachine: null, ws: null,
};

// ---------------- Login Editorial Showcase Carousel ----------------
const SHOWCASE_SLIDES = [
  {
    label: "Pixel2Plot Studio",
    quote: "Turn any image into crisp pen-drawn artwork on paper.",
    pill: "Precision Plotting",
  },
  {
    label: "Live Simulation",
    quote: "Preview every stroke before the pen touches paper.",
    pill: "Path Preview",
  },
  {
    label: "Smart Calibration",
    quote: "Balanced speed and fine detail in a single click.",
    pill: "Auto Optimize",
  },
  {
    label: "Remote Workspace",
    quote: "Queue, pause, and monitor every plotter in one place.",
    pill: "Fleet Control",
  },
];

let showcaseIndex = 0;
let showcaseTimer = null;

function setShowcaseSlide(idx) {
  const labelEl = $("#showcaseSlideLabel");
  const quoteEl = $("#showcaseSlideQuote");
  const pillEl = $("#showcaseSlidePill");
  const stage = $("#showcaseCopyStage");
  if (!labelEl || !quoteEl || !pillEl) return;

  showcaseIndex = (idx + SHOWCASE_SLIDES.length) % SHOWCASE_SLIDES.length;
  const slide = SHOWCASE_SLIDES[showcaseIndex];

  if (stage) {
    stage.classList.remove("slide-swap");
    void stage.offsetWidth;
    stage.classList.add("slide-swap");
  }
  labelEl.textContent = slide.label;
  quoteEl.textContent = slide.quote;
  pillEl.textContent = slide.pill;

  $$("#showcaseBars .seg").forEach((seg, i) => {
    seg.classList.remove("active", "done");
    if (i < showcaseIndex) seg.classList.add("done");
    if (i === showcaseIndex) {
      void seg.offsetWidth;
      seg.classList.add("active");
    }
  });
}

function startShowcaseCycle() {
  stopShowcaseCycle();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  showcaseTimer = setInterval(() => {
    if (!$("#loginView")?.classList.contains("hidden")) {
      setShowcaseSlide(showcaseIndex + 1);
    }
  }, 5000);
}

function stopShowcaseCycle() {
  if (showcaseTimer) {
    clearInterval(showcaseTimer);
    showcaseTimer = null;
  }
}

$("#showcaseBars")?.addEventListener("click", (e) => {
  const seg = e.target.closest(".seg[data-slide]");
  if (!seg) return;
  setShowcaseSlide(Number(seg.dataset.slide));
  startShowcaseCycle();
});

$("#showcaseCard")?.addEventListener("mouseenter", stopShowcaseCycle);
$("#showcaseCard")?.addEventListener("mouseleave", startShowcaseCycle);

// ---------------- API ----------------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const session = app.session;
  if (session) headers["X-Session-Context"] = session;
  if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (res.status === 401 && session && session === app.session) {
    clearSession("Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.");
  }
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(body.error || `Lỗi máy chủ (HTTP ${res.status})`), { status: res.status });
  return body;
}

// ---------------- Notification UI ----------------
const recentToasts = new Map();

function toast(text, kind = "", key = null) {
  const toastKey = key || `${kind}:${text}`;
  const now = Date.now();
  if (recentToasts.has(toastKey) && (now - recentToasts.get(toastKey) < 3500)) {
    return;
  }
  recentToasts.set(toastKey, now);
  if (recentToasts.size > 50) {
    for (const [k, t] of recentToasts) {
      if (now - t > 10000) recentToasts.delete(k);
    }
  }

  const el = document.createElement("div");
  el.className = `toast ${kind}`.trim();
  const dot = document.createElement("span");
  dot.className = "toast-dot";
  dot.setAttribute("aria-hidden", "true");
  const msg = document.createElement("span");
  msg.className = "toast-text";
  msg.textContent = text;
  el.append(dot, msg);
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------------- Auth View ----------------
const sessionChannel = new BroadcastChannel("pixel2plot-session");
sessionChannel.onmessage = () => location.reload();

const loginForm = $("#loginForm");
const loginError = $("#loginError");
const authSubmit = loginForm.querySelector("button[type=submit]");
const authModeButton = $("#authModeBtn");
const googleButton = $("#googleAuthBtn");
let registration = false;
let authBusy = true;
let googleAvailable = false;

function updateAuthControls(busy) {
  authBusy = busy;
  authSubmit.disabled = busy;
  authModeButton.disabled = busy;
  googleButton.disabled = busy || !googleAvailable;
}

function setAuthMode(signUp, focus = false) {
  registration = signUp;
  $("#authHeading").textContent = signUp ? "Tạo tài khoản Pixel2Plot" : "Đăng nhập vào Pixel2Plot";
  $("#authModeHint").textContent = signUp ? "Đã có tài khoản?" : "Chưa có tài khoản?";
  authModeButton.textContent = signUp ? "Đăng nhập" : "Đăng ký";
  authSubmit.textContent = signUp ? "Tạo tài khoản" : "Đăng nhập";
  const { username, password, confirmation } = loginForm.elements;
  password.value = "";
  password.autocomplete = signUp ? "new-password" : "current-password";
  password.minLength = signUp ? 12 : 0;
  password.placeholder = signUp ? "Ít nhất 12 ký tự" : "Nhập mật khẩu";
  confirmation.value = "";
  confirmation.disabled = !signUp;
  confirmation.required = signUp;
  $("#confirmPasswordField").classList.toggle("hidden", !signUp);
  loginError.textContent = "";
  if (focus) username.focus();
}

function requestSession(path, options) {
  const request = () => api(path, options);
  return navigator.locks ? navigator.locks.request("pixel2plot-auth", request) : request();
}

authModeButton.addEventListener("click", () => setAuthMode(!registration, true));

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (authBusy) return;
  const f = new FormData(loginForm);
  const username = f.get("username").trim();
  const password = f.get("password");
  loginError.textContent = "";
  if (registration && password !== f.get("confirmation")) {
    loginError.textContent = "Hai mật khẩu chưa khớp.";
    loginForm.elements.confirmation.focus();
    return;
  }
  updateAuthControls(true);
  try {
    const result = await requestSession(registration ? "/auth/register" : "/auth/login", { method: "POST", json: { username, password } });
    loginForm.reset();
    openSession(result);
    sessionChannel.postMessage("login");
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    updateAuthControls(false);
  }
});

googleButton.addEventListener("click", async () => {
  if (authBusy || !googleAvailable) return;
  loginError.textContent = "";
  updateAuthControls(true);
  try {
    const { url } = await api("/auth/google/start", { method: "POST" });
    location.assign(url);
  } catch (err) {
    loginError.textContent = err.message;
    updateAuthControls(false);
  }
});

function openSession({ context, user }) {
  app.session = context;
  app.user = user;
  enterApp();
}

function clearSession(message = "") {
  app.session = null;
  app.user = null;
  setAuthMode(false);
  loginError.textContent = message;
  clearMachineToken();
  $("#resetPassword").close();
  $("#resetPasswordForm").reset();
  app.ws?.close();
  app.ws = null;
  setConnection(false, "Đang kết nối");
  app.machines = [];
  app.selectedMachine = null;
  cachedJobs = [];
  selectJobFilter("all");
  updateJobFilterCounts();
  $("#machinePick").replaceChildren();
  $("#machineInfo")?.replaceChildren();
  $("#machinesSummary")?.replaceChildren();
  $("#allJobs").checked = false;
  $("#jobDetails").close();
  $("#jobRows").replaceChildren();
  $$("#admMachines, #admUsers, #admQueue").forEach((table) => table.replaceChildren());
  pendingSend = null;
  trackingReady = false;
  resetWorkspace();
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  setShowcaseSlide(0);
  startShowcaseCycle();
}
$("#logoutBtn").onclick = async (e) => {
  const button = e.currentTarget;
  const session = app.session;
  button.disabled = true;
  try {
    await api("/auth/logout", { method: "POST" });
    if (session === app.session) clearSession();
    sessionChannel.postMessage("logout");
  } catch (err) {
    if (session === app.session) toast("Chưa đăng xuất được. " + err.message, "err");
  } finally {
    button.disabled = false;
  }
};

function enterApp() {
  stopShowcaseCycle();
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#whoami").textContent = app.user.username;
  const avatar = $("#userAvatar");
  if (avatar) avatar.textContent = (app.user.username || "U")[0].toUpperCase();
  $$(".admin-only").forEach((el) => el.classList.toggle("hidden", app.user.role !== "admin"));
  connectWs();
  pendingSend = readPendingSend();
  const session = app.session;
  const machinesReady = loadMachines().catch((err) => toast(err.message, "err"));
  refreshTrackedJob().catch((err) => toast(err.message, "err"));
  draftLoading = true;
  machinesReady.then(() => app.session === session && restoreDraft()).finally(() => {
    if (app.session !== session) return;
    draftLoading = false;
    syncActions();
  });
  showTab("draw");
  if (pendingSend) $("#sendMsg").textContent = "Có một lần gửi chưa xác nhận. Chọn Xác nhận lại lần gửi.";
  syncActions();
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
  else pausePlayback();
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
let revision = 0, candidates = [], savedDrawingId, sentJob, activeJob = null, sending = false, view = "paths";
let pendingSend, draftLoading = false, restoredDraft = false, draftEpoch = 0;
let liveConnected = false, jobVersion = 0, refreshTimer, trackingReady = false;
const userKey = () => `${app.user.id}:${app.user.username}`;
const storageKey = (name) => `pixel2plot:${name}:${userKey()}`;

function readPendingSend() {
  try { return JSON.parse(localStorage.getItem(storageKey("pending"))); }
  catch { return null; }
}

function setPendingSend(request) {
  pendingSend = request;
  try {
    if (request) localStorage.setItem(storageKey("pending"), JSON.stringify(request));
    else localStorage.removeItem(storageKey("pending"));
  } catch {
    if (request) toast("Trình duyệt không lưu được lần gửi này. Hãy giữ trang mở nếu cần thử lại.", "warn");
  }
}

const draftControls = () => [...form.querySelectorAll("input[name], select[name]")].filter((el) => el !== fileInput);

function saveDraft() {
  if (!app.user || !file) return;
  const session = app.session, epoch = ++draftEpoch;
  const settings = Object.fromEntries(draftControls().map((el) => [el.name, el.type === "checkbox" ? el.checked : el.value]));
  writeDraft(userKey(), { file, settings, machineId: app.selectedMachine, sentId: sentJob?.id, editor: drawingEditor.snapshot() }).catch(() => {
    if (app.session === session && epoch === draftEpoch) $("#draftStatus").textContent = "Trình duyệt không lưu được bản nháp.";
  });
}

async function restoreDraft() {
  const session = app.session;
  try {
    const draft = await readDraft(userKey());
    if (!draft || session !== app.session || file) return;
    for (const el of draftControls()) {
      if (!Object.hasOwn(draft.settings, el.name)) continue;
      if (el.type === "checkbox") el.checked = draft.settings[el.name];
      else el.value = draft.settings[el.name];
    }
    if (app.machines.some((m) => m.id === draft.machineId)) {
      app.selectedMachine = draft.machineId;
      renderMachinePick();
    }
    updateSizeLimits();
    updateFormLabels();
    handleSelectedFile(draft.file, draft.editor);
    if (draft.sentId) {
      sentJob = activeJob?.id === draft.sentId ? activeJob : { id: draft.sentId, status: "QUEUED" };
      saveDraft();
      refreshTrackedJob().catch((err) => toast(err.message, "err"));
    }
    restoredDraft = true;
    $("#draftStatus").textContent = "Đã khôi phục bản nháp trên trình duyệt này.";
    syncActions();
  } catch {
    if (app.session === session) $("#draftStatus").textContent = "Trình duyệt không đọc được bản nháp.";
  }
}

$("#discardDraft").onclick = async () => {
  if (!app.user || pendingSend || sending) return;
  const session = app.session;
  try {
    const key = userKey();
    const tracked = activeJob;
    resetWorkspace();
    activeJob = tracked;
    renderActiveJobBar();
    await deleteDraft(key);
  } catch {
    if (session === app.session) $("#draftStatus").textContent = "Chưa xóa được bản nháp khỏi trình duyệt.";
  }
};

const playback = { open: false, progress: 0, frame: null, speed: 1, lastTime: 0 };
const PLAYBACK_MS = 12000;
const playbackScrubber = $("#playbackPosition");
const playbackPercent = $("#playbackPercent");
const playbackPenState = $("#playbackPenState");
const formatPlaybackPercent = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1, maximumFractionDigits: 1,
});
const drawingEditor = mountDrawingEditor({
  root: $("#drawingEditor"),
  options: $("#drawingEditorOptions"),
  canvas,
  getArea: workArea,
  getPreview: () => preview,
  isLocked: () => sending || Boolean(pendingSend || tuneRequest) || playback.open,
  hasFile: () => Boolean(file),
  selectPaths: () => selectView("paths"),
  redraw: drawPreview,
  onStateChange: syncActions,
  onEdit: (paths) => {
    if (preview) {
      const ordered = paths.flatMap((path) => path.slice(1).map((point, i) => ({
        x: path[i].x, y: path[i].y, nx: point.x, ny: point.y, ink: true,
      })));
      displayed = { ...preview, moves: { ordered } };
    }
    schedulePreview({ delay: 0, keepImage: true });
  },
});

function workArea() {
  const machine = app.machines.find((m) => m.id === app.selectedMachine);
  return machine ? { w: machine.work_width, h: machine.work_height } : { w: 120, h: 80 };
}

function updateSizeLimits() {
  const { w, h } = workArea();
  for (const [input, limit] of [[form.widthMm, w], [form.heightMm, h]]) {
    input.max = limit;
    if (input.valueAsNumber > limit) input.value = limit;
  }
  $("#sizeHint").textContent = `Tối đa ${w} × ${h} mm. Ảnh giữ nguyên tỷ lệ khi vẽ.`;
}

function readParams() {
  const tm = form.thresholdMode.value;
  const p = {
    widthMm: +form.widthMm.value, heightMm: +form.heightMm.value, detail: +form.detail.value,
    threshold: tm === "manual" ? +form.threshold.value : tm,
    invert: form.invert.value, mode: form.mode.value, smoothing: +form.smoothing.value,
    despeckle: form.despeckle.checked, penWidthMm: +form.penWidthMm.value,
  };
  if (form.simplifyMm && form.simplifyMm.value !== "") p.simplifyMm = +form.simplifyMm.value;
  if (form.hatchRatio && form.hatchRatio.value !== "") p.hatchRatio = +form.hatchRatio.value;
  if (form.fillStrategy) p.fillStrategy = form.fillStrategy.value;
  if (form.rasterPx && form.rasterPx.value !== "") p.rasterPx = +form.rasterPx.value;
  for (const name of ["drawFeed", "controlledTravelFeed", "penLiftZ", "penLowerFeed"]) {
    if (form[name].value !== "") p[name] = form[name].valueAsNumber;
  }
  return p;
}

function uploadData(params, machineId, edits) {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("params", JSON.stringify(params));
  if (machineId) fd.append("machineId", machineId);
  if (edits?.length) fd.append("edits", JSON.stringify(edits));
  return fd;
}

function selectView(next) {
  closePlayback();
  view = next;
  drawPreview();
  syncActions();
}

function pausePlayback() {
  if (playback.frame !== null) cancelAnimationFrame(playback.frame);
  playback.frame = null;
  $("#playbackBtn").textContent = playback.progress === 1 ? "Phát lại" : playback.progress ? "Tiếp tục" : "Phát";
}

function closePlayback() {
  pausePlayback();
  playback.open = false;
  playback.progress = 0;
}

function playPlayback() {
  if (playback.progress === 1) playback.progress = 0;
  playback.lastTime = performance.now();
  const advance = (now) => {
    updatePlayback(now);
    if (playback.progress === 1) pausePlayback();
    else playback.frame = requestAnimationFrame(advance);
  };
  $("#playbackBtn").textContent = "Tạm dừng";
  playback.frame = requestAnimationFrame(advance);
}

function updatePlayback(now) {
  const elapsed = Math.max(0, now - playback.lastTime);
  playback.lastTime += elapsed;
  playback.progress = Math.min(1, playback.progress + elapsed * playback.speed / PLAYBACK_MS);
  drawPreview();
}

function drawPreview() {
  const area = workArea();
  const size = {
    w: Math.min(+form.widthMm.value || area.w, area.w),
    h: Math.min(+form.heightMm.value || area.h, area.h),
  };
  const head = playback.open ? playbackPosition(preview.moves, playback.progress) : null;
  const showTravel = view === "paths" && $("#showTravel").checked;
  paintPreview(canvas, { area, size, image: original, preview: displayed, view, head, showTravel,
    camera: drawingEditor.camera, overlay: view === "paths" && !playback.open ? drawingEditor.overlay : null });
  if (head) {
    const percent = Math.floor(playback.progress * 1000) / 10;
    const state = playback.progress === 1 ? "Đã về gốc" : head.ink ? "Bút đang vẽ" : "Bút nhấc";
    playbackScrubber.value = Math.round(playback.progress * Number(playbackScrubber.max));
    updateSliderTrack(playbackScrubber);
    const label = `${formatPlaybackPercent.format(percent)}%`;
    if (playbackPercent.textContent !== label) playbackPercent.textContent = label;
    if (playbackPenState.textContent !== state) playbackPenState.textContent = state;
    return;
  }
  const hasFile = Boolean(file);
  const emptyEl = $("#emptyPreview");
  const zone = $("#dropZone");
  if (emptyEl) {
    emptyEl.hidden = hasFile;
    emptyEl.classList.toggle("hidden", hasFile);
  }
  if (zone) {
    zone.classList.toggle("is-empty", !hasFile);
  }
}

function updateStepper() {
  const steps = [$("#stepIndicator1"), $("#stepIndicator2"), $("#stepIndicator3"), $("#stepIndicator4")];
  if (!steps[0]) return;
  let activeIdx = 0;
  if (sentJob || pendingSend || (!file && activeJob)) activeIdx = 3;
  else if (preview && app.selectedMachine) activeIdx = 2;
  else if (file) activeIdx = 1;

  steps.forEach((el, idx) => {
    el.classList.toggle("active", idx === activeIdx);
    el.classList.toggle("done", idx < activeIdx);
  });
}

function updateStepGuide() {
  const guideText = $("#guideText");
  const nextStepGuide = $("#nextStepGuide");
  if (!guideText || !nextStepGuide) return;
  const machine = app.machines.find((m) => m.id === app.selectedMachine);

  nextStepGuide.classList.remove("guide-warn", "guide-subtle");

  if (sentJob || pendingSend || sending) {
    nextStepGuide.hidden = true;
    return;
  }

  if (!file) {
    nextStepGuide.hidden = false;
    nextStepGuide.classList.add("guide-subtle");
    guideText.textContent = "Bước 1: Chọn ảnh PNG hoặc JPG để bắt đầu.";
  } else if (previewRequest || previewTimer) {
    nextStepGuide.hidden = false;
    nextStepGuide.classList.add("guide-subtle");
    guideText.textContent = "Đang tạo bản xem trước đường vẽ…";
  } else if (!preview) {
    nextStepGuide.hidden = false;
    nextStepGuide.classList.add("guide-warn");
    guideText.textContent = "Chưa có bản xem trước hợp lệ. Hãy kiểm tra lại thông số hoặc ảnh.";
  } else if (!app.selectedMachine) {
    nextStepGuide.hidden = false;
    nextStepGuide.classList.add("guide-subtle");
    guideText.textContent = "Chọn máy vẽ ở danh sách trên để gửi.";
  } else if (machine && (!machine.online || machine.needs_inspection || machine.state === "WAIT_PAPER")) {
    nextStepGuide.hidden = false;
    nextStepGuide.classList.add("guide-warn");
    guideText.textContent = !machine.online ? "Bản vẽ sẽ chờ máy kết nối." :
      machine.needs_inspection ? "Bản vẽ sẽ chờ người tại máy kiểm tra giấy." : "Bản vẽ sẽ chờ đặt giấy.";
  } else {
    nextStepGuide.hidden = true;
  }
}

function syncActions() {
  drawingEditor.sync();
  const hasDrawing = Boolean(preview?.stats.paths) && !drawingEditor.busy;
  $("#pathsView").disabled = !file;
  $("#imageView").disabled = !original?.naturalWidth;
  $("#compareView").disabled = !displayed || !original?.naturalWidth;
  for (const [id, mode] of [["pathsView", "paths"], ["imageView", "image"], ["compareView", "compare"]]) {
    $("#" + id).setAttribute("aria-pressed", String(!playback.open && view === mode));
  }
  $("#showTravel").disabled = view !== "paths" || !displayed;
  $("#simulateBtn").disabled = !playback.open && (!hasDrawing || !preview?.moves.distance || Boolean(tuneRequest) || sending);
  $("#simulateBtn").setAttribute("aria-expanded", String(playback.open));
  $("#simulateBtn").textContent = playback.open ? "Đóng mô phỏng" : "Mô phỏng";
  $("#playbackControls").hidden = !playback.open;
  canvas.setAttribute("aria-label", playback.open ? "Mô phỏng đường bút" : {
    paths: "Đường vẽ theo tọa độ máy", image: "Ảnh gốc trong vùng vẽ", compare: "Đường bút chồng lên ảnh gốc",
  }[view]);
  $("#downloadBtn").disabled = !hasDrawing;
  $("#gcodeDetails").classList.toggle("hidden", !hasDrawing);

  const canSend = !sending && (pendingSend ? !draftLoading : hasDrawing && app.selectedMachine && !sentJob && !tuneRequest);
  $("#sendBtn").disabled = !canSend;
  $("#sendBtn").textContent = sending ? "Đang gửi…" : pendingSend ? "Xác nhận lại lần gửi" : sentJob ? `Đã gửi #${sentJob.id}` : "Gửi bản vẽ";
  $("#showSentJob").classList.toggle("hidden", !sentJob);
  form.inert = sending || Boolean(pendingSend);
  fileInput.disabled = sending || Boolean(pendingSend);
  $("#discardDraft").hidden = !file;
  $("#discardDraft").disabled = sending || Boolean(pendingSend);
  if ($("#machineSelect")) $("#machineSelect").disabled = sending || Boolean(pendingSend);
  if ($("#autoBtn")) {
    const autoRunning = tuneRequest?.profile === "both";
    $("#autoBtn").disabled = !file || !form.checkValidity() || Boolean(tuneRequest) || Boolean(pendingSend);
    $("#autoBtn").classList.toggle("is-loading", autoRunning);
    const labelSpan = $("#autoBtn .auto-cta-text");
    if (labelSpan) labelSpan.textContent = autoRunning ? "Đang tìm cấu hình…" : "Gợi ý cấu hình";
  }
  $$("[data-tune]").forEach((button) => {
    const profile = button.dataset.tune;
    button.disabled = !file || !form.checkValidity() || Boolean(tuneRequest) || Boolean(pendingSend);
    button.textContent = tuneRequest?.profile === profile ? "Đang dò…" : TUNE_LABELS[profile];
  });

  updateStepper();
  updateStepGuide();
  renderActiveJobBar();
}

function renderActiveJobBar() {
  const bar = $("#activeJobBar");
  if (!bar) return;
  const current = sentJob || activeJob;
  if (!current) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  $("#activeJobTitle").textContent = `Phiên #${current.id}: ${current.drawing_name || "Bản vẽ"} · ${current.machine_name || current.machine_id}`;
  $("#activeJobBadge").innerHTML = badge(current.cancel_requested ? "CANCEL_REQUESTED" : current.status);
  const notice = jobNotice(current);
  $("#activeJobNotice").textContent = [
    !liveConnected || !trackingReady ? "Tiến độ cuối đã nhận · đang chờ đồng bộ." : "",
    notice,
  ].filter(Boolean).join(" ");
  if (sentJob?.machine_name) {
    const state = current.cancel_requested ? "CANCEL_REQUESTED" : current.status;
    const next = `Đã nhận phiên #${current.id} · ${current.machine_name}. ${notice || (STATUS_VI[state] + ".")}`;
    const message = $("#sendMsg");
    if (message.textContent !== next) message.textContent = next;
  }
  const pct = Number(current.progress) || 0;
  const fill = $("#activeJobBarFill");
  fill.style.width = `${pct}%`;
  fill.classList.toggle("bar-complete", pct >= 100);
  $("#activeJobPercent").textContent = `${pct}%`;

  const btn = (act, label, cls = "") => `<button type="button" class="small ${cls}" data-quick-job="${current.id}" data-act="${act}">${label}</button>`;
  const canControl = liveConnected && trackingReady && !current.cancel_requested && (current.machine_online || current.status === "QUEUED");
  const actions = [
    canControl && current.status === "DRAWING" && btn("pause", "Tạm dừng"),
    canControl && current.status === "PAUSED" && btn("resume", "Tiếp tục"),
    !current.cancel_requested && (current.status === "QUEUED" || liveConnected && trackingReady)
      && !["COMPLETED", "CANCELLED", "FAILED"].includes(current.status) && btn("cancel", "Hủy", "danger"),
    `<button type="button" class="small ghost" data-quick-job="${current.id}" data-act="details">Chi tiết</button>`,
  ].filter(Boolean).join(" ");
  if ($("#activeJobActions").dataset.content !== actions) {
    $("#activeJobActions").innerHTML = actions;
    $("#activeJobActions").dataset.content = actions;
  }
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
  const session = app.session, version = jobVersion;
  btn.disabled = true;
  try {
    const { job } = await api(`/jobs/${id}/${act}`, { method: "POST" });
    if (app.session !== session || version !== jobVersion) return;
    onJobStatus(job);
    const message = act === "cancel" ? (jobNotice(job) || "Đã hủy lượt đang chờ.") :
      `Đã gửi lệnh ${act === "pause" ? "tạm dừng" : "tiếp tục"}.`;
    toast(`Phiên #${id}: ${message}`, job.cancel_requested ? "warn" : "ok");
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
    if (app.session === session) refreshJobViews();
  }
});

function clearTuneResult() {
  tuneRequest?.controller.abort();
  tuneRequest = null;
  candidates = [];
  $("#autoResult").replaceChildren();
}

function schedulePreview({ delay = 260, keepTuneResult = false, keepImage = false, keepSubmission = false } = {}) {
  drawingEditor.cancelPending();
  const current = ++revision;
  clearTimeout(previewTimer);
  previewTimer = null;
  previewRequest?.abort();
  previewRequest = null;
  if (!keepTuneResult) clearTuneResult();
  closePlayback();
  preview = null;
  if (!keepImage || !form.checkValidity()) displayed = null;
  if (!displayed && view === "compare") view = "paths";
  if (!keepSubmission) {
    savedDrawingId = null;
    sentJob = null;
  }
  $("#stats").textContent = "";
  $("#gcodeText").textContent = "";
  $("#gcodeDetails").open = false;
  if (!pendingSend) $("#sendMsg").textContent = "";
  $("#retryPreview").classList.add("hidden");
  syncActions();
  drawPreview();
  if (!file) { $("#convertMsg").textContent = ""; return; }
  saveDraft();
  if (!form.checkValidity()) {
    const invalid = form.querySelector(":invalid");
    const label = invalid?.dataset?.label || invalid?.labels?.[0]?.childNodes[0]?.textContent.trim() || "Thông số";
    const problem = invalid?.validity.rangeUnderflow ? `nhập từ ${invalid.min} trở lên.`
      : invalid?.validity.rangeOverflow ? `nhập tối đa ${invalid.max}.`
      : invalid?.validity.stepMismatch ? `nhập theo bước ${invalid.step}.`
      : invalid?.validity.patternMismatch ? "tối đa 20 ký tự gồm chữ, số, dấu cách, chấm và gạch ngang."
      : "nhập giá trị hợp lệ.";
    $("#convertMsg").textContent = `${label}: ${problem}`;
    $("#sendBtn").disabled = true;
    return;
  }
  $("#convertMsg").textContent = displayed ? "Đang cập nhật… Tạm hiển thị đường vẽ trước đó." : "Đang tạo bản xem trước…";
  previewTimer = setTimeout(() => {
    previewTimer = null;
    runPreview(current);
  }, delay);
}

async function runPreview(current) {
  const controller = new AbortController();
  previewRequest = controller;
  const params = readParams(), machineId = app.selectedMachine, edits = drawingEditor.currentEdits();
  try {
    const result = await api("/drawings/preview", { method: "POST", body: uploadData(params, machineId, edits), signal: controller.signal });
    if (current !== revision) return;
    preview = { ...result, requestParams: params, edits, moves: readMoves(result.gcode, result.params) };
    displayed = preview;
    const { stats: s } = result;
    const [left, bottom, right, top] = edits.length ? preview.moves.ordered.reduce((bounds, move) => {
      if (move.ink) {
        bounds[0] = Math.min(bounds[0], move.x, move.nx);
        bounds[1] = Math.min(bounds[1], move.y, move.ny);
        bounds[2] = Math.max(bounds[2], move.x, move.nx);
        bounds[3] = Math.max(bounds[3], move.y, move.ny);
      }
      return bounds;
    }, [Infinity, Infinity, -Infinity, -Infinity]) : s.bbox;
    $("#stats").textContent = s.paths ? [
      `${Number((right - left).toFixed(1))} × ${Number((top - bottom).toFixed(1))} mm`,
      `${s.paths} nét`, `ước tính ~${s.minutes} phút`,
      ...(edits.length ? [] : [`độ khớp mô phỏng ${s.iou}%`, `tách nét: ${METHOD_VI[s.binarize.method] || s.binarize.method}`]),
    ].join(" · ") : "";
    $("#gcodeText").textContent = result.gcode.length > 200000 ? result.gcode.slice(0, 200000) + "\n…" : result.gcode;
    $("#convertMsg").textContent = s.paths ? "Bản xem trước sẵn sàng." : "Không còn nét vẽ. Hoàn tác hoặc chọn một phiên bản trước.";
    drawPreview();
  } catch (err) {
    if (current !== revision || err.name === "AbortError") return;
    displayed = null;
    if (view === "compare") view = "paths";
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

function updateSliderTrack(slider) {
  if (!slider) return;
  const min = Number(slider.min) || 0;
  const max = Number(slider.max) || 100;
  const val = Number(slider.value) || 0;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  slider.style.setProperty("--slider-pct", `${pct}%`);
}

function updateFormLabels() {
  $("#detailVal").textContent = form.detail.value;
  const hasDetailOverride = form.rasterPx.value !== "" || form.simplifyMm.value !== "";
  $("#detailOverrideHint").hidden = !hasDetailOverride;
  if (hasDetailOverride) form.detail.setAttribute("aria-describedby", "detailOverrideHint");
  else form.detail.removeAttribute("aria-describedby");
  $("#thresholdVal").textContent = form.threshold.value;
  $("#thresholdRow").classList.toggle("hidden", form.thresholdMode.value !== "manual");
  const isFill = form.mode.value === "fill";
  $("#fillAdvancedGroup")?.classList.toggle("adv-inactive", !isFill);
  const fillNote = $("#fillModeNote");
  if (fillNote) fillNote.hidden = isFill;
  updateSliderTrack(form.detail);
  updateSliderTrack(form.threshold);
}

function resetWorkspace() {
  releaseOriginal();
  file = null;
  drawingEditor.reset();
  restoredDraft = false;
  ++draftEpoch;
  $("#draftStatus").textContent = "";
  fileInput.value = "";
  form.reset();
  updateSizeLimits();
  updateFormLabels();
  view = "paths";
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

function handleSelectedFile(newFile, editorState) {
  if (sending || !newFile || pendingSend && file) return;
  const error = $("#fileError");
  const message = !["image/png", "image/jpeg"].includes(newFile.type)
    ? "Chọn ảnh định dạng PNG hoặc JPG."
    : newFile.size > MAX_FILE_SIZE ? "Ảnh vượt quá 5 MB. Chọn ảnh nhỏ hơn." : "";
  error.textContent = message || "";
  error.hidden = !message;
  if (message) { fileInput.value = ""; return; }
  releaseOriginal();
  file = newFile;
  drawingEditor.reset(editorState);
  view = "paths";
  if (restoredDraft) $("#draftStatus").textContent = "";
  restoredDraft = false;
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
fileInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") fileInput.click();
});

// Close history popover on outside click
document.addEventListener("click", (e) => {
  const hist = $("#drawingHistory");
  if (hist?.open && !hist.contains(e.target)) hist.open = false;
});

// Drag & drop + click-to-upload when empty
const dropZone = $("#dropZone");
if (dropZone) {
  dropZone.addEventListener("click", () => {
    if (!file && !sending && !pendingSend) fileInput.click();
  });
  dropZone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !file && !sending && !pendingSend) {
      e.preventDefault();
      fileInput.click();
    }
  });
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
    if (droppedFile && !pendingSend) {
      handleSelectedFile(droppedFile);
    }
  });
}

// Smooth scroll inside settingsCard when Advanced Options expands
const advancedDetails = $("#advancedOptions");
if (advancedDetails) {
  advancedDetails.addEventListener("toggle", () => {
    if (!advancedDetails.open) return;
    const scroller = $("#settingsCard");
    if (!scroller) return;
    requestAnimationFrame(() => {
      const targetTop = advancedDetails.offsetTop - 12;
      scroller.scrollTo({ top: targetTop, behavior: "smooth" });
    });
  });
}

form.addEventListener("input", (event) => {
  if (event.target === fileInput) return;
  if (event.target === form.detail) {
    form.rasterPx.value = "";
    form.simplifyMm.value = "";
    if (view === "image") view = "paths";
  }
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
  updateSizeLimits();
  updateFormLabels();
  schedulePreview({ delay: 0 });
};
$("#pathsView").onclick = () => selectView("paths");
$("#imageView").onclick = () => { drawingEditor.cancel(); selectView("image"); };
$("#compareView").onclick = () => { drawingEditor.cancel(); selectView("compare"); };
$("#simulateBtn").onclick = () => {
  if (playback.open) return selectView("paths");
  if (!preview?.moves.distance || drawingEditor.busy) return;
  drawingEditor.cancel();
  view = "paths";
  playback.open = true;
  syncActions();
  drawPreview();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) playPlayback();
};
$("#playbackBtn").onclick = () => {
  if (playback.frame === null) playPlayback();
  else pausePlayback();
};
playbackScrubber.oninput = () => {
  playback.progress = playbackScrubber.valueAsNumber / Number(playbackScrubber.max);
  pausePlayback();
  drawPreview();
};
$("#playbackSpeed").onchange = (event) => {
  if (playback.frame !== null) {
    updatePlayback(performance.now());
    if (playback.progress === 1) pausePlayback();
  }
  playback.speed = Number(event.target.value);
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pausePlayback();
});
$("#showTravel").onchange = drawPreview;
$("#retryPreview").onclick = () => schedulePreview({ delay: 0, keepSubmission: true });
new ResizeObserver(drawPreview).observe(canvas.parentElement);

$$("[data-tune]").forEach((button) => {
  button.onclick = () => tuneDrawing(button.dataset.tune);
});
if ($("#autoBtn")) {
  $("#autoBtn").onclick = () => tuneDrawing("both");
}

function renderTuneSkeleton(profile) {
  const card = (title, sub) => `
    <div class="cand cand-loading">
      <div class="cand-top">
        <strong>${title}</strong>
        <span class="cand-spinner-pill"><span class="mini-spin" aria-hidden="true"></span>Đang chạy</span>
      </div>
      <div class="cand-skeleton-lines" aria-hidden="true">
        <span class="skel-bar skel-w80"></span>
        <span class="skel-bar skel-w60"></span>
      </div>
      <div class="cand-loading-sub muted">${sub}</div>
    </div>`;

  if (profile === "both") {
    return `<div class="cand-grid">
      ${card("Chi tiết", "Tối ưu độ trùng nét")}
      ${card("Nhanh", "Tối ưu tốc độ vẽ")}
    </div>`;
  }
  return card(
    TUNE_LABELS[profile],
    `Đang dò cấu hình · tối đa ${profile === "fast" ? 15 : 45} giây`,
  );
}

async function tuneDrawing(profile) {
  if (tuneRequest || sending || pendingSend) return;
  const controller = new AbortController();
  const request = { controller, profile };
  tuneRequest = request;
  const panel = $("#autoResult");
  panel.innerHTML = renderTuneSkeleton(profile);
  syncActions();
  try {
    const body = uploadData(readParams(), app.selectedMachine);
    if (profile && profile !== "both") body.append("profile", profile);
    const result = await api("/drawings/auto", {
      method: "POST", body, signal: controller.signal,
    });
    if (tuneRequest !== request) return;
    candidates = result.candidates || [];
    const fmt = (val) => Number(val).toLocaleString("vi-VN", { maximumFractionDigits: 1 });
    if (profile === "both") {
      const elapsed = fmt(result.ms / 1000);
      const same = candidates.length === 2 && JSON.stringify(candidates[0].params) === JSON.stringify(candidates[1].params);
      panel.innerHTML = `<div class="auto-result-summary"><small class="muted">Đã đánh giá ${result.tried} cấu hình trong ${elapsed} giây.${result.timeLimited ? " Đã chọn phương án tốt nhất." : ""}</small>`
        + (same ? '<small class="muted">Hai phương án cho cùng thông số với ảnh này.</small>' : "")
        + `</div><div class="cand-grid">`
        + candidates.map((c, i) => `
          <div class="cand cand-reveal" style="animation-delay:${i * 90}ms">
            <div class="cand-top">
              <strong>${esc(c.label)}</strong>
              <span class="cand-match tabular-nums">${fmt(c.metrics.iou)}%</span>
            </div>
            <div class="cand-info">
              <small class="muted">${MODE_VI[c.params.mode]} · Mức ${c.params.detail}</small>
              <small class="muted tabular-nums">~${fmt(c.metrics.minutes)} phút · ${Number(c.metrics.paths).toLocaleString("vi-VN")} nét</small>
            </div>
            <button type="button" class="small cand-apply-btn" data-cand="${i}" aria-pressed="false" aria-label="Xác nhận cấu hình ${esc(c.label)}">Xác nhận</button>
          </div>`).join("")
        + `</div>`;
    } else {
      const [candidate] = candidates;
      if (!candidate) { panel.textContent = "Chưa tìm được nét phù hợp. Kiểm tra ảnh gốc hoặc đổi ảnh."; return; }
      const { params, metrics } = candidate;
      applyParams(params);
      panel.innerHTML = `<div class="cand cand-selected cand-reveal">
        <div class="cand-top">
          <strong>${TUNE_LABELS[profile]} · ${MODE_VI[params.mode]}</strong>
          <span class="cand-match tabular-nums">${fmt(metrics.iou)}%</span>
        </div>
        <div class="cand-info">
          <small class="muted tabular-nums">Ước tính ~${fmt(metrics.minutes)} phút · Đã áp dụng</small>
          <small class="muted">Tìm trong ${fmt(result.ms / 1000)} giây · ${result.verified}/${result.tried} cấu hình đã kiểm tra${result.timeLimited ? " · Đã chọn tốt nhất" : ""}</small>
        </div>
      </div>`;
      schedulePreview({ delay: 0, keepTuneResult: true, keepImage: true });
    }
  } catch (err) {
    if (tuneRequest === request) panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    if (tuneRequest === request) { tuneRequest = null; syncActions(); }
  }
}

function applyParams(params) {
  if (!params) return;
  if (form.detail && params.detail !== undefined) form.detail.value = params.detail;
  if (form.mode && params.mode !== undefined) form.mode.value = params.mode;
  if (form.smoothing && params.smoothing !== undefined) form.smoothing.value = params.smoothing;
  if (form.simplifyMm && params.simplifyMm !== undefined) form.simplifyMm.value = params.simplifyMm ?? "";
  if (form.hatchRatio && params.hatchRatio !== undefined) form.hatchRatio.value = params.hatchRatio;
  if (form.fillStrategy && params.fillStrategy !== undefined) form.fillStrategy.value = params.fillStrategy;
  if (form.rasterPx && params.rasterPx !== undefined) form.rasterPx.value = params.rasterPx ?? "";
  if (form.despeckle && params.despeckle !== undefined) form.despeckle.checked = params.despeckle;
  if (form.thresholdMode && params.threshold !== undefined) {
    form.thresholdMode.value = params.threshold === "adaptive" ? "adaptive" : "manual";
  }
  if (form.threshold && params.threshold !== undefined && params.threshold !== "adaptive") {
    form.threshold.value = params.threshold;
  }
  if (form.invert && params.invert !== undefined) form.invert.value = String(params.invert);
  updateFormLabels();
  view = "paths";
}

$("#autoResult").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-cand]");
  if (!button) return;
  const { params } = candidates[+button.dataset.cand];
  applyParams(params);
  $$("#autoResult [data-cand]").forEach((choice) => {
    const isChosen = choice === button;
    choice.classList.toggle("primary", isChosen);
    choice.setAttribute("aria-pressed", String(isChosen));
    choice.textContent = isChosen ? "Đã chọn" : "Xác nhận";
    choice.closest(".cand")?.classList.toggle("cand-selected", isChosen);
  });
  schedulePreview({ delay: 0, keepTuneResult: true, keepImage: true });
});

$("#downloadBtn").onclick = () => {
  if (!preview?.stats.paths || drawingEditor.busy) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([preview.gcode], { type: "text/plain" }));
  link.download = (file ? file.name.replace(/\.[^.]+$/, "") : "drawing") + ".gcode";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

$("#showSentJob").onclick = () => { if (sentJob) openJobDetails(sentJob.id); };
$("#sendBtn").onclick = async () => {
  if (sending || (pendingSend ? draftLoading : tuneRequest || sentJob || !preview?.stats.paths || drawingEditor.busy || !app.selectedMachine)) return;
  const current = revision;
  const session = app.session;
  const machineId = app.selectedMachine;
  sending = true;
  $("#sendMsg").textContent = pendingSend ? "Đang kiểm tra lần gửi trước…" : "Đang lưu và gửi bản vẽ…";
  syncActions();
  try {
    if (!pendingSend) {
      let drawingId = savedDrawingId;
      if (!drawingId) {
        const { previewHash, requestParams, edits } = preview;
        const body = uploadData(requestParams, machineId, edits);
        body.append("previewHash", previewHash);
        const result = await api("/drawings", { method: "POST", body });
        if (app.session !== session) return;
        drawingId = result.drawing.id;
        if (current === revision) savedDrawingId = drawingId;
      }
      const requestKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      setPendingSend({ drawingId, machineId, requestKey });
    }
    const version = jobVersion;
    const { job } = await api("/jobs", { method: "POST", json: pendingSend });
    if (app.session !== session) return;
    rememberJob(job.id);
    setPendingSend(null);
    if (current === revision) {
      sentJob = version !== jobVersion && activeJob?.id === job.id ? activeJob : job;
      activeJob = sentJob;
      trackingReady = liveConnected;
      saveDraft();
    } else {
      activeJob = job;
      trackingReady = liveConnected;
      toast(`Đã nhận phiên #${job.id} · ${job.machine_name}.`, "ok");
    }
  } catch (err) {
    if (app.session !== session) return;
    if (pendingSend && (!err.status || err.status >= 500)) {
      $("#sendMsg").textContent = "Chưa nhận được xác nhận. Chọn Xác nhận lại lần gửi để kiểm tra cùng yêu cầu.";
    } else if (err.status === 409 && !pendingSend && !savedDrawingId) {
      await loadMachines().catch(() => {});
      if (app.session !== session) return;
      schedulePreview({ delay: 0 });
      $("#sendMsg").textContent = "Bản xem trước đã thay đổi. Đang cập nhật…";
    } else {
      setPendingSend(null);
      $("#sendMsg").textContent = err.status
        ? `Chưa gửi được · ${err.message}`
        : "Chưa nhận được phản hồi từ máy chủ. Hãy thử gửi lại.";
    }
  } finally {
    if (app.session === session) { sending = false; syncActions(); }
  }
};

// ---------------- Machine Selector & Hardware Fleet View ----------------
async function loadMachines() {
  const session = app.session;
  const previous = app.selectedMachine;
  const area = workArea();
  const { machines } = await api("/machines");
  if (session !== app.session) return;
  app.machines = machines;
  if (!machines.some((m) => m.id === app.selectedMachine)) {
    const online = machines.filter((m) => m.online);
    app.selectedMachine = (online.length === 1 ? online[0] : machines.find((m) => m.id === "sim-01") || machines[0] || null)?.id ?? null;
  }
  renderMachinePick();
  renderMachineCards();
  if (previous !== app.selectedMachine || area.w !== workArea().w || area.h !== workArea().h) machineChanged();
}

function machineChanged() {
  updateSizeLimits();
  if (!sending && !pendingSend) schedulePreview({ keepSubmission: true });
}

function renderMachinePick() {
  const container = $("#machinePick");
  if (!container) return;
  if (!app.machines.length) {
    container.innerHTML = '<p class="muted">Chưa có máy vẽ trong hệ thống.</p>';
    renderMachineInfo();
    return;
  }
  container.innerHTML = `
    <select id="machineSelect" aria-label="Chọn máy nhận lệnh">
      <option value="" disabled ${app.selectedMachine ? "" : "selected"}>Chọn máy nhận</option>
      ${app.machines.map((m) => `<option value="${esc(m.id)}" ${app.selectedMachine === m.id ? "selected" : ""}>${esc(m.name)} · ${esc(m.id)}</option>`).join("")}
    </select>`;
  $("#machineSelect").onchange = (event) => {
    app.selectedMachine = event.target.value;
    renderMachineInfo();
    if (file) {
      sentJob = null;
      savedDrawingId = null;
    }
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
    <span class="machine-dim tabular-nums">${m.work_width} × ${m.work_height} mm</span>
    ${badge(m.needs_inspection && m.online ? "INSPECTION" : m.state)}`
    : '<span class="muted">Chưa chọn máy</span>';
}

function machineBedSvg(m) {
  const maxW = 92, maxH = 56;
  const ratio = (m.work_width || 120) / (m.work_height || 80);
  const w = ratio >= maxW / maxH ? maxW : Math.max(36, Math.round(maxH * ratio));
  const h = ratio >= maxW / maxH ? Math.max(28, Math.round(maxW / ratio)) : maxH;
  const x = Math.round((116 - w) / 2);
  const y = Math.round((74 - h) / 2);
  const dotColor = m.online ? "#10B981" : "#EF4444";
  return `
    <svg class="machine-bed-svg" viewBox="0 0 116 74" width="116" height="74" fill="none" aria-hidden="true">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#FFFFFF" stroke="#D4D4D8" stroke-width="1"/>
      <line x1="${x + Math.round(w / 3)}" y1="${y}" x2="${x + Math.round(w / 3)}" y2="${y + h}" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
      <line x1="${x + Math.round(w * 2 / 3)}" y1="${y}" x2="${x + Math.round(w * 2 / 3)}" y2="${y + h}" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
      <line x1="${x}" y1="${y + Math.round(h / 2)}" x2="${x + w}" y2="${y + Math.round(h / 2)}" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
      <circle cx="${x + 6}" cy="${y + h - 6}" r="2.2" fill="#171717"/>
      <circle cx="${x + w - 7}" cy="${y + 7}" r="3" fill="${dotColor}"/>
    </svg>`;
}

function renderMachineCards() {
  const container = $("#machineCards");
  const summary = $("#machinesSummary");
  if (summary) {
    const total = app.machines.length;
    const online = app.machines.filter((m) => m.online).length;
    const queued = app.machines.reduce((acc, m) => acc + (Number(m.queued) || 0), 0);
    summary.innerHTML = total ? `
      <span class="fleet-pill"><strong>${total}</strong> thiết bị</span>
      <span class="fleet-pill fleet-pill-ok"><i class="fleet-dot"></i><strong>${online}</strong> trực tuyến</span>
      <span class="fleet-pill"><strong>${queued}</strong> đang chờ</span>
    ` : "";
  }
  if (!container) return;
  if (!app.machines.length) {
    container.innerHTML = '<div class="empty-inline muted">Chưa có máy vẽ nào được cấu hình.</div>';
    return;
  }
  container.innerHTML = app.machines.map((m) => {
    const isSelected = app.selectedMachine === m.id;
    return `
    <article class="machine-row-card ${m.online ? "is-online" : "is-offline"} ${isSelected ? "is-selected" : ""}">
      <div class="machine-bed-preview">
        ${machineBedSvg(m)}
      </div>
      <div class="machine-row-main">
        <div class="machine-row-top">
          <div class="machine-identity">
            <h2>${esc(m.name)}</h2>
            <code class="machine-id-pill">${esc(m.id)}</code>
          </div>
          ${badge(m.needs_inspection && m.online ? "INSPECTION" : m.state)}
        </div>
        <dl class="machine-specs-inline">
          <div>
            <dt>Vùng vẽ</dt>
            <dd class="tabular-nums">${m.work_width} × ${m.work_height} mm</dd>
          </div>
          <div>
            <dt>Hàng đợi</dt>
            <dd class="tabular-nums">${m.queued} phiên</dd>
          </div>
          <div>
            <dt>Tín hiệu cuối</dt>
            <dd class="tabular-nums">${m.last_seen ? new Date(m.last_seen).toLocaleTimeString("vi-VN") : "Chưa kết nối"}</dd>
          </div>
        </dl>
      </div>
      <div class="machine-row-action">
        <button type="button" class="small ${isSelected ? "" : "primary"}" data-use-machine="${esc(m.id)}">
          ${isSelected ? "Đang chọn · Mở bàn vẽ" : "Vẽ trên máy này →"}
        </button>
      </div>
    </article>`;
  }).join("");
}

$("#machineCards")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-use-machine]");
  if (!btn) return;
  const id = btn.dataset.useMachine;
  if (app.selectedMachine !== id) {
    if (sending || pendingSend) return;
    app.selectedMachine = id;
    if (file) {
      sentJob = null;
      savedDrawingId = null;
    }
    renderMachinePick();
    machineChanged();
  }
  showTab("draw");
});

// ---------------- Job List + Client Status Filters + Job Control ----------------
let jobsRequest = 0;
let cachedJobs = [];
let jobFilter = "all";
const pendingJobActions = new Set();
const jobsBody = $("#jobRows");
const jobDetails = $("#jobDetails");

function matchesJobFilter(job, filter) {
  if (filter === "all") return true;
  if (filter === "active") return ["QUEUED", "SENDING", "READY", "DRAWING", "PAUSED"].includes(job.status);
  if (filter === "done") return job.status === "COMPLETED";
  if (filter === "ended") return ["CANCELLED", "FAILED"].includes(job.status);
  return true;
}

function updateJobFilterCounts() {
  const counts = {
    all: cachedJobs.length,
    active: cachedJobs.filter((j) => matchesJobFilter(j, "active")).length,
    done: cachedJobs.filter((j) => matchesJobFilter(j, "done")).length,
    ended: cachedJobs.filter((j) => matchesJobFilter(j, "ended")).length,
  };
  if ($("#jobCountAll")) $("#jobCountAll").textContent = String(counts.all);
  if ($("#jobCountActive")) $("#jobCountActive").textContent = String(counts.active);
  if ($("#jobCountDone")) $("#jobCountDone").textContent = String(counts.done);
  if ($("#jobCountEnded")) $("#jobCountEnded").textContent = String(counts.ended);
}

function renderJobsTable() {
  updateJobFilterCounts();
  const visible = cachedJobs.filter((j) => matchesJobFilter(j, jobFilter));
  const emptyText = cachedJobs.length
    ? "Không có phiên vẽ nào thuộc trạng thái này."
    : "Chưa có phiên vẽ nào.";
  jobsBody.innerHTML = visible.map(jobRow).join("")
    || `<tr><td colspan="8" class="muted table-empty-cell">${emptyText}</td></tr>`;
}

function selectJobFilter(filter) {
  jobFilter = filter;
  $$("#jobFilterBar .filter-chip").forEach((b) => {
    const active = b.dataset.jobFilter === jobFilter;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
}

$("#jobFilterBar")?.addEventListener("click", (e) => {
  const chip = e.target.closest("button[data-job-filter]");
  if (!chip) return;
  selectJobFilter(chip.dataset.jobFilter);
  renderJobsTable();
});

async function loadJobs() {
  const request = ++jobsRequest, session = app.session;
  const all = $("#allJobs").checked ? "?all=1" : "";
  const { jobs } = await api(`/jobs${all}`);
  if (request !== jobsRequest || session !== app.session) return;
  cachedJobs = jobs;
  renderJobsTable();
}

$("#allJobs").onchange = () => loadJobs().catch((err) => toast(err.message, "err"));

function jobNotice(job) {
  const machine = app.machines.find((m) => m.id === job.machine_id);
  const online = machine?.online ?? job.machine_online;
  const state = machine?.state ?? job.machine_state;
  if (job.cancel_requested) return online
    ? "Đang chờ máy xác nhận dừng."
    : "Chưa xác nhận dừng · máy mất kết nối. Nếu cần dừng ngay, dùng nút Stop tại máy.";
  if (job.status === "QUEUED") {
    const ahead = job.ahead > 0 ? ` Có ${job.ahead} lượt trước bạn.` : "";
    const wait = !online ? "Đang chờ máy kết nối." : (machine?.needs_inspection ?? job.needs_inspection)
      ? "Đang chờ người tại máy kiểm tra giấy."
      : state === "WAIT_PAPER" ? "Đang chờ giấy." : "Đã vào hàng đợi.";
    return wait + ahead;
  }
  if (["SENDING", "READY", "DRAWING", "PAUSED"].includes(job.status)) {
    if (!online) return "Máy mất kết nối. Đây là tiến độ đã nhận gần nhất.";
    if (state === "WAIT_PAPER") return "Đang chờ người tại máy đặt giấy.";
  }
  return job.error || "";
}

function jobRow(j) {
  const btn = (action, label, cls = "") => `<button class="small ${cls}" data-job="${j.id}" data-act="${action}" ${pendingJobActions.has(j.id) ? "disabled" : ""}>${label}</button>`;
  const actions = [
    liveConnected && j.machine_online && !j.cancel_requested && j.status === "DRAWING" && btn("pause", "Tạm dừng"),
    liveConnected && j.machine_online && !j.cancel_requested && j.status === "PAUSED" && btn("resume", "Tiếp tục"),
    !j.cancel_requested && (liveConnected || j.status === "QUEUED") && !["COMPLETED", "CANCELLED", "FAILED"].includes(j.status) && btn("cancel", "Hủy", "danger"),
    `<button class="small ghost btn-detail" type="button" data-details="${j.id}">Chi tiết</button>`,
  ].filter(Boolean).join(" ");
  const progress = Number(j.progress) || 0;
  return `<tr id="job-${j.id}">
    <td class="col-id tabular-nums">${j.id}</td>
    <td class="col-name"><button class="job-name" type="button" data-details="${j.id}">${esc(j.drawing_name)}</button></td>
    <td class="col-mach">${esc(j.machine_name)}</td>
    <td class="col-user">${esc(j.username)}</td>
    <td class="col-status">${badge(j.cancel_requested ? "CANCEL_REQUESTED" : j.status)}${jobNotice(j) ? `<span class="status-subnote">${esc(jobNotice(j))}</span>` : ""}</td>
    <td class="col-progress"><div class="progress-inline"><div class="bar"><span style="width:${progress}%" class="${progress >= 100 ? "bar-complete" : ""}"></span></div><small class="tabular-nums progress-pct-label">${progress}%</small></div></td>
    <td class="col-time"><small class="tabular-nums">${formatDate(j.created_at)}</small></td>
    <td class="col-actions"><div class="job-actions">${actions}</div></td>
  </tr>`;
}

function formatDate(value) {
  return new Date(value.endsWith("Z") ? value : value + "Z").toLocaleString("vi-VN");
}

const EVENT_VI = {
  QUEUED: "Đã vào hàng đợi",
  SENDING: "Đang truyền bản vẽ",
  FILE_SENT: "Đã gửi dữ liệu bản vẽ",
  FILE_OK: "Máy đã nhận đầy đủ dữ liệu",
  JOB_READY: "Máy sẵn sàng vẽ",
  JOB_START: "Bắt đầu vẽ",
  JOB_DONE: "Hoàn thành bản vẽ",
  JOB_FAILED: "Lỗi trong quá trình vẽ",
  PAUSED: "Đã tạm dừng",
  RESUMED: "Đã tiếp tục vẽ",
  CANCEL_REQUESTED: "Đã yêu cầu hủy, đang chờ máy xác nhận",
  CANCELLED_IN_QUEUE: "Đã rút phiên khỏi hàng đợi",
  CANCELLED: "Máy xác nhận đã dừng phiên",
  JOB_INTERRUPTED: "Phiên bị gián đoạn, cần kiểm tra giấy",
};

function formatTimeOnly(value) {
  const d = new Date(value.endsWith("Z") ? value : value + "Z");
  return d.toLocaleTimeString("vi-VN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatFullDateTime(value) {
  const d = new Date(value.endsWith("Z") ? value : value + "Z");
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }) + " lúc " +
         d.toLocaleTimeString("vi-VN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

let detailsRequest = 0;
let detailsState = "";

function jobDetailsState(job) {
  return `${job.status}:${job.cancel_requested}:${jobNotice(job)}`;
}

function openJobDetails(id) {
  jobDetails.dataset.jobId = id;
  detailsState = "";
  $("#jobDetailsTitle").textContent = `Phiên vẽ #${id}`;
  $("#jobDetailsBody").textContent = "Đang tải chi tiết…";
  jobDetails.showModal();
  loadJobDetails(id);
}

async function loadJobDetails(id) {
  const request = ++detailsRequest;
  const body = $("#jobDetailsBody");
  try {
    const { job, events } = await api(`/jobs/${id}`);
    if (request !== detailsRequest || !jobDetails.open) return;
    detailsState = jobDetailsState(job);
    body.innerHTML = `
      <div class="job-meta-card">
        <div class="job-meta-header">
          <h3 class="job-meta-title">${esc(job.drawing_name)}</h3>
          ${badge(job.cancel_requested ? "CANCEL_REQUESTED" : job.status)}
        </div>
        <div class="job-meta-grid">
          <div class="job-meta-item">
            <span class="meta-label">Máy vẽ</span>
            <span class="meta-val">${esc(job.machine_name)}</span>
          </div>
          <div class="job-meta-item">
            <span class="meta-label">Người gửi</span>
            <span class="meta-val">${esc(job.username)}</span>
          </div>
          <div class="job-meta-item">
            <span class="meta-label">Tạo lúc</span>
            <span class="meta-val tabular-nums">${formatFullDateTime(job.created_at)}</span>
          </div>
        </div>
      </div>
      ${jobNotice(job) ? `<p class="muted dialog-notice">${esc(jobNotice(job))}</p>` : ""}
      <div class="job-timeline-wrap">
        <h3 class="timeline-title">Nhật ký phiên</h3>
        ${events.length ? `
          <ol class="job-events job-timeline">
            ${events.map((event) => `
              <li class="timeline-item">
                <span class="timeline-bullet" aria-hidden="true"></span>
                <time class="timeline-time tabular-nums">${formatTimeOnly(event.created_at)}</time>
                <div class="timeline-desc-wrap">
                  <span class="timeline-desc">${esc(EVENT_VI[event.event] || STATUS_VI[event.event] || event.event)}</span>
                  ${event.detail ? `<span class="timeline-detail">${esc(event.detail)}</span>` : ""}
                </div>
              </li>
            `).join("")}
          </ol>
        ` : '<p class="muted">Chưa có sự kiện ghi nhận.</p>'}
      </div>
    `;
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
  const session = app.session, version = jobVersion;
  let updated;
  try { ({ job: updated } = await api(`/jobs/${id}/${button.dataset.act}`, { method: "POST" })); }
  catch (err) { toast(err.message, "err"); }
  finally {
    pendingJobActions.delete(id);
    if (app.session === session) {
      if (updated && version === jobVersion) onJobStatus(updated);
      else $(`#job-${id}`)?.querySelectorAll("[data-act]").forEach((action) => { action.disabled = false; });
      refreshJobViews();
    }
  }
});

function replaceJobRow(job) {
  const idx = cachedJobs.findIndex((item) => item.id === job.id);
  if (idx >= 0) {
    cachedJobs[idx] = { ...cachedJobs[idx], ...job };
    updateJobFilterCounts();
  }
  const row = $(`#job-${job.id}`);
  if (!row) return false;
  if (!matchesJobFilter(job, jobFilter)) {
    renderJobsTable();
    return true;
  }
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
  const session = app.session;
  const [{ machines }, { users }, { jobs }] = await Promise.all([api("/admin/machines"), api("/admin/users"), api("/admin/queue")]);
  if (session !== app.session) return;
  if ($("#admMachinesCount")) $("#admMachinesCount").textContent = String(machines.length);
  if ($("#admUsersCount")) $("#admUsersCount").textContent = String(users.length);
  if ($("#admQueueCount")) $("#admQueueCount").textContent = String(jobs.length);

  $("#admMachines").innerHTML = machines.map((m) => `<tr>
    <td><code>${esc(m.id)}</code></td><td><strong>${esc(m.name)}</strong></td><td>${badge(m.needs_inspection && m.online ? "INSPECTION" : m.state)}${m.enabled ? "" : " · Tắt"}</td>
    <td class="tabular-nums">${m.work_width}×${m.work_height}</td><td><button type="button" class="small ghost" data-m="${esc(m.id)}" data-a="show-token">Xem token</button></td>
    <td class="col-actions"><div class="admin-row-actions">${m.needs_inspection && m.online && m.state === "IDLE"
          ? `<button class="small" data-m="${esc(m.id)}" data-a="inspection">Xác nhận đã kiểm tra giấy</button>` : ""}
        <button class="small ghost" data-m="${esc(m.id)}" data-a="home" ${m.enabled && m.online && ["IDLE", "ERROR"].includes(m.state) ? "" : "disabled"}>Về gốc</button>
        <button class="small ghost" data-m="${esc(m.id)}" data-a="token">Đổi token</button>
        <button class="small ${m.enabled ? "danger" : "ghost"}" data-m="${esc(m.id)}" data-a="toggle" data-en="${m.enabled}">${m.enabled ? "Tắt" : "Bật"}</button></div></td></tr>`).join("");
  $("#admUsers").innerHTML = users.map((u) => `<tr>
    <td class="col-id tabular-nums">${u.id}</td><td><strong>${esc(u.username)}</strong></td><td><code>${u.role}</code></td><td>${u.locked ? badge("FAILED").replace("Lỗi", "Đã khóa") : badge("IDLE").replace("Sẵn sàng", "Hoạt động")}</td>
    <td class="col-actions"><div class="admin-row-actions">
      <button class="small ghost" data-u="${u.id}" data-a="password" data-name="${esc(u.username)}">Đặt lại mật khẩu</button>
      <button class="small ghost" data-u="${u.id}" data-a="revoke" data-name="${esc(u.username)}">Đăng xuất mọi thiết bị</button>
      ${u.id === app.user.id ? "" : `<button class="small ${u.locked ? "ghost" : "danger"}" data-u="${u.id}" data-a="lock" data-locked="${u.locked}">${u.locked ? "Mở khóa" : "Khóa"}</button>`}
    </div></td></tr>`).join("");
  $("#admQueue").innerHTML = jobs.map((j) => `<tr><td class="col-id tabular-nums">${j.id}</td><td><code>${esc(j.machine_id)}</code></td><td>${esc(j.drawing_name)}</td><td>${esc(j.username)}</td><td>${badge(j.status)}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted table-empty-cell">Hàng đợi hệ thống đang trống.</td></tr>`;
}

const machineTokenDialog = $("#machineToken");
const machineTokenValue = $("#machineTokenValue");

function clearMachineToken() {
  machineTokenValue.value = "";
  machineTokenDialog.close();
}

machineTokenDialog.addEventListener("close", () => { machineTokenValue.value = ""; });

$("#admMachines").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-m]");
  if (!b) return;
  const session = app.session;
  b.disabled = true;
  try {
    if (b.dataset.a === "show-token") {
      const { token } = await api(`/admin/machines/${b.dataset.m}/token`);
      if (session !== app.session) return;
      $("#machineTokenTitle").textContent = `Token MQTT · ${b.dataset.m}`;
      machineTokenValue.value = token;
      if (!machineTokenDialog.open) machineTokenDialog.showModal();
      machineTokenValue.select();
      return;
    }
    if (b.dataset.a === "inspection") {
      if (!confirm("Bạn đã kiểm tra giấy và vùng vẽ tại máy? Lượt kế tiếp có thể bắt đầu ngay.")) return;
      await api(`/admin/machines/${b.dataset.m}/inspection`, { method: "POST" });
      toast("Đã xác nhận kiểm tra giấy.", "ok");
    }
    if (b.dataset.a === "home") { await api(`/admin/machines/${b.dataset.m}/home`, { method: "POST" }); toast("Đã gửi lệnh về gốc", "ok"); }
    if (b.dataset.a === "token" && confirm("Cấp token mới? Máy phải cập nhật token mới mới kết nối lại được.")) {
      await api(`/admin/machines/${b.dataset.m}/token`, { method: "POST" });
      toast("Đã cấp token mới", "ok");
    }
    if (b.dataset.a === "toggle") await api(`/admin/machines/${b.dataset.m}`, { method: "PATCH", json: { enabled: b.dataset.en !== "1" } });
    if (session === app.session) await loadAdmin();
  } catch (err) { if (session === app.session) toast(err.message, "err"); }
  finally { b.disabled = false; }
});

const resetPasswordDialog = $("#resetPassword");
const resetPasswordForm = $("#resetPasswordForm");
resetPasswordDialog.addEventListener("close", () => resetPasswordForm.reset());

$("#admUsers").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-u]");
  if (!b) return;
  if (b.dataset.a === "password") {
    resetPasswordForm.reset();
    resetPasswordForm.dataset.user = b.dataset.u;
    $("#resetPasswordError").textContent = "";
    $("#resetPasswordTitle").textContent = `Đặt lại mật khẩu · ${b.dataset.name}`;
    resetPasswordDialog.showModal();
    return;
  }

  const session = app.session;
  b.disabled = true;
  try {
    if (b.dataset.a === "revoke") {
      if (!confirm(`Đăng xuất ${b.dataset.name} khỏi tất cả thiết bị?`)) return;
      await api(`/admin/users/${b.dataset.u}/revoke-sessions`, { method: "POST" });
      if (session !== app.session) return;
      if (Number(b.dataset.u) === app.user.id) {
        clearSession("Đã đăng xuất tất cả thiết bị.");
        sessionChannel.postMessage("logout");
        return;
      }
      toast("Đã thu hồi tất cả phiên đăng nhập.", "ok");
    } else {
      await api(`/admin/users/${b.dataset.u}`, { method: "PATCH", json: { locked: b.dataset.locked !== "1" } });
    }
    if (session === app.session) await loadAdmin();
  } catch (err) { if (session === app.session) toast(err.message, "err"); }
  finally { b.disabled = false; }
});

resetPasswordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const session = app.session;
  const button = e.submitter || resetPasswordForm.querySelector("button[type=submit]");
  if (button.disabled) return;
  const id = resetPasswordForm.dataset.user;
  button.disabled = true;
  $("#resetPasswordError").textContent = "";
  try {
    const password = new FormData(resetPasswordForm).get("password");
    await api(`/admin/users/${id}/password`, { method: "POST", json: { password } });
    if (session !== app.session) return;
    resetPasswordDialog.close();
    if (Number(id) === app.user.id) {
      clearSession("Đã đổi mật khẩu. Vui lòng đăng nhập lại.");
      sessionChannel.postMessage("logout");
    } else {
      toast("Đã đặt lại mật khẩu và thu hồi các phiên cũ.", "ok");
    }
  } catch (err) {
    if (session === app.session) $("#resetPasswordError").textContent = err.message;
  } finally {
    button.disabled = false;
  }
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
function rememberJob(id) {
  try { localStorage.setItem(storageKey("job"), String(id)); }
  catch { /* Tracking still works while the page is open. */ }
}

async function refreshTrackedJob() {
  const session = app.session;
  const current = sentJob || activeJob;
  let id = current?.id;
  if (!id) {
    try { id = Number(localStorage.getItem(storageKey("job"))); }
    catch { return; }
  }
  if (!id) return;
  const version = jobVersion;
  try {
    const { job } = await api(`/jobs/${id}`);
    if (session !== app.session || version !== jobVersion) return;
    if (sentJob?.id === id) sentJob = job;
    activeJob = job;
    trackingReady = liveConnected;
    renderActiveJobBar();
    replaceJobRow(job);
  } catch (error) {
    if (session !== app.session || version !== jobVersion) return;
    if (error.status !== 404) throw error;
    try { localStorage.removeItem(storageKey("job")); } catch {}
    if (sentJob?.id === id) sentJob = null;
    if (activeJob?.id === id) activeJob = null;
    syncActions();
  }
}

function refreshJobViews() {
  const session = app.session;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (session !== app.session) return;
    refreshTrackedJob().catch((err) => toast(err.message, "err"));
    if (jobDetails.open) loadJobDetails(jobDetails.dataset.jobId);
    if (!$("#tab-jobs").classList.contains("hidden")) loadJobs().catch((err) => toast(err.message, "err"));
  }, 180);
}

function setConnection(connected, label) {
  liveConnected = connected;
  if (!connected) {
    trackingReady = false;
    ++jobVersion;
  }
  $("#wsDot").classList.toggle("on", connected);
  $("#wsLabel").textContent = label;
  renderActiveJobBar();
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?context=${encodeURIComponent(app.session)}`);
  app.ws = ws;
  ws.onclose = (e) => {
    if (app.ws !== ws) return;
    if (e.code === 4001) {
      clearSession("Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.");
      return;
    }
    setConnection(false, "Mất cập nhật trực tiếp");
    for (const button of jobsBody.querySelectorAll("[data-act]:not(.danger)")) button.disabled = true;
    if (app.session) setTimeout(() => {
      if (app.session && app.ws === ws) connectWs();
    }, 2000);
  };
  ws.onmessage = (ev) => {
    if (app.ws !== ws) return;
    const { type, data } = JSON.parse(ev.data);
    if (type === "hello") {
      setConnection(true, "Cập nhật trực tiếp");
      loadMachines().catch((err) => toast(err.message, "err"));
      refreshJobViews();
      if (!$("#tab-admin").classList.contains("hidden")) loadAdmin().catch((err) => toast(err.message, "err"));
    }
    if (type === "machine.status") onMachineStatus(data);
    if (type === "queue.changed") {
      const machine = app.machines.find((item) => item.id === data.machineId);
      if (machine && Number.isInteger(data.queued)) {
        machine.queued = data.queued;
        if (!$("#tab-machines").classList.contains("hidden")) renderMachineCards();
      }
      if (data.machineId === app.selectedMachine || data.machineId === (sentJob || activeJob)?.machine_id
          || !$("#tab-jobs").classList.contains("hidden")) refreshJobViews();
    }
    if (type === "job.status") onJobStatus(data);
    if (type === "job.completed") toast(`Phiên #${data.id} (${data.drawing_name}) đã vẽ xong`, "ok", `job-${data.id}-completed`);
    if (type === "job.failed") toast(`Phiên #${data.id} lỗi: ${data.error}`, "err", `job-${data.id}-failed`);
  };
}

function onMachineStatus(m) {
  const i = app.machines.findIndex((x) => x.id === m.id);
  if (i >= 0) app.machines[i] = { ...app.machines[i], ...m };
  renderMachineInfo(); renderMachineCards();
  syncActions();
  if (m.state === "OFFLINE") toast(`${machineLabel(m.name)} mất kết nối`, "warn");
  if (m.event === "ERROR") toast(`${machineLabel(m.name)}: ${m.error}`, "err");
  refreshJobViews();
  if (!$("#tab-admin").classList.contains("hidden")) loadAdmin();
}

function onJobStatus(j) {
  const tracked = sentJob || activeJob;
  if (tracked?.id === j.id || !tracked && j.user_id === app.user.id) {
    ++jobVersion;
    trackingReady = true;
    if (sentJob?.id === j.id) sentJob = j;
    activeJob = j;
  }
  if (jobDetails.open && Number(jobDetails.dataset.jobId) === j.id) {
    const state = jobDetailsState(j);
    if (state !== detailsState) {
      detailsState = state;
      loadJobDetails(j.id);
    }
  }
  renderActiveJobBar();
  if (!replaceJobRow(j) && !$("#tab-jobs").classList.contains("hidden")) loadJobs().catch((err) => toast(err.message, "err"));
  if (!$("#tab-admin").classList.contains("hidden")) loadAdmin();
}

// ---------------- Boot ----------------
$$("input[type=range]").forEach((r) => {
  updateSliderTrack(r);
  r.addEventListener("input", () => updateSliderTrack(r));
});
async function restoreSession() {
  updateAuthControls(true);
  const options = api("/auth/options")
    .then(({ google }) => { googleAvailable = google; })
    .catch(() => { googleAvailable = false; })
    .finally(() => {
      const note = $("#googleAuthNote");
      note.hidden = googleAvailable;
      if (!googleAvailable) note.textContent = "Google chưa được cấu hình cho địa chỉ này.";
      googleButton.disabled = authBusy || !googleAvailable;
    });
  const url = new URL(location.href);
  const google = url.searchParams.get("google");
  if (google !== null) {
    url.searchParams.delete("google");
    history.replaceState(null, "", url);
  }
  const messages = {
    cancelled: "Đã hủy đăng nhập Google.",
    expired: "Lượt đăng nhập Google đã hết hạn. Vui lòng thử lại.",
    failed: "Chưa xác thực được tài khoản Google. Vui lòng thử lại.",
  };
  let message = Object.hasOwn(messages, google) ? messages[google] : "";
  try {
    if (google === "finish") {
      try {
        openSession(await requestSession("/auth/google/finish", { method: "POST" }));
        sessionChannel.postMessage("login");
        return;
      } catch (err) {
        message = err.message;
      }
    }
    openSession(await api("/auth/me"));
    if (message) toast(message, "warn");
  } catch (err) {
    clearSession(message || (err.status === 401 ? "" : err.message));
  } finally {
    await options;
    updateAuthControls(false);
  }
}

try {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
} catch { /* Storage can be disabled by the browser. */ }
window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
restoreSession();
drawPreview();
