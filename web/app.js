import { paintPreview, readMoves } from "./preview.js";

// Pixel2Plot Operator — web client (không cần build, chạy thẳng trên trình duyệt)
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STATUS_VI = {
  QUEUED: "Chờ", SENDING: "Đang gửi file", READY: "Sẵn sàng", DRAWING: "Đang vẽ", PAUSED: "Tạm dừng",
  COMPLETED: "Hoàn thành", CANCELLED: "Đã hủy", FAILED: "Lỗi",
  IDLE: "Rảnh", OFFLINE: "Mất kết nối", RECEIVING: "Đang nhận file", HOMING: "Về gốc", ERROR: "Lỗi", BOOT: "Khởi động",
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
    throw new Error("Phiên đăng nhập hết hạn");
  }
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

// ---------------- Notification UI ----------------
function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 5000);
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
  $("#whoami").textContent = `${app.user.username} (${app.user.role})`;
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
const MODE_VI = { centerline: "Đường tâm", outline: "Đường viền", fill: "Viền + tô gạch" };
const METHOD_VI = { otsu: "Otsu", adaptive: "thích nghi", fixed: "thủ công" };
const MAX_FILE_SIZE = 5 * 1024 * 1024;
let file, original, originalUrl, preview, displayed, previewTimer, previewRequest, tuneRequest;
let revision = 0, candidates = [], savedDrawingId, sentJob, sending = false, showImage = false;

function workArea() {
  const machine = app.machines.find((m) => m.id === app.selectedMachine);
  return machine ? { w: machine.work_width, h: machine.work_height } : { w: 200, h: 200 };
}

function readParams() {
  const tm = form.thresholdMode.value;
  return {
    widthMm: +form.widthMm.value, heightMm: +form.heightMm.value, detail: +form.detail.value,
    threshold: tm === "manual" ? +form.threshold.value : tm,
    invert: form.invert.value, mode: form.mode.value, smoothing: +form.smoothing.value,
    simplifyMm: form.simplifyMm.value === "" ? null : +form.simplifyMm.value, hatchRatio: +form.hatchRatio.value,
    despeckle: form.despeckle.checked, penWidthMm: +form.penWidthMm.value,
    drawFeed: +form.drawFeed.value, travelFeed: +form.travelFeed.value,
    penUp: form.penUp.value.trim(), penDown: form.penDown.value.trim(),
  };
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
  $("#emptyPreview").hidden = Boolean(file);
  canvas.setAttribute("aria-label", showImage ? "Ảnh gốc trong vùng vẽ" : "Đường vẽ theo tọa độ máy");
}

function syncActions() {
  $("#pathsView").disabled = !file;
  $("#imageView").disabled = !original?.naturalWidth;
  $("#pathsView").setAttribute("aria-pressed", String(!showImage));
  $("#imageView").setAttribute("aria-pressed", String(showImage));
  $("#showTravel").disabled = showImage || !displayed;
  $("#downloadBtn").disabled = !preview;
  $("#gcodeDetails").classList.toggle("hidden", !preview);
  $("#sendBtn").disabled = !preview || !app.selectedMachine || sending || Boolean(sentJob);
  $("#sendBtn").textContent = sending ? "Đang gửi…" : sentJob ? `Đã gửi #${sentJob.id}` : "Gửi bản vẽ";
  $("#showSentJob").classList.toggle("hidden", !sentJob);
  form.inert = sending;
  fileInput.disabled = sending;
  if ($("#machineSelect")) $("#machineSelect").disabled = sending;
  $("#autoBtn").disabled = !file || !form.checkValidity() || Boolean(tuneRequest);
  $("#autoBtn").textContent = tuneRequest ? "Đang tìm cấu hình…" : "Tìm cấu hình phù hợp";
}

function clearCandidates() {
  tuneRequest?.abort();
  tuneRequest = null;
  candidates = [];
  $("#autoResult").replaceChildren();
}

function schedulePreview({ delay = 260, keepCandidates = false, keepImage = false } = {}) {
  const current = ++revision;
  clearTimeout(previewTimer);
  previewRequest?.abort();
  previewRequest = null;
  if (!keepCandidates) clearCandidates();
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
      : invalid?.validity.patternMismatch ? "dùng tối đa 20 ký tự gồm chữ, số, dấu cách, chấm và gạch ngang."
      : "nhập giá trị hợp lệ.";
    $("#convertMsg").textContent = `${label}: ${problem}`;
    return;
  }
  $("#convertMsg").textContent = displayed ? "Đang cập nhật… Tạm hiển thị đường vẽ trước đó." : "Đang tạo bản xem trước…";
  previewTimer = setTimeout(() => runPreview(current), delay);
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
      `${s.paths} nét`, `ước tính ${s.minutes} phút`, `độ khớp ${s.iou}%`,
      `tách nét ${METHOD_VI[s.binarize.method] || s.binarize.method}`,
    ].join(" · ");
    $("#gcodeText").textContent = result.gcode.length > 200000 ? result.gcode.slice(0, 200000) + "\n…" : result.gcode;
    $("#convertMsg").textContent = "Bản xem trước đã cập nhật.";
    drawPreview();
  } catch (err) {
    if (current !== revision || err.name === "AbortError") return;
    displayed = null;
    drawPreview();
    $("#convertMsg").textContent = err.message;
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
  $("#showTravel").checked = false;
  $("#fileInfo").textContent = "PNG hoặc JPG · tối đa 5 MB";
  $("#fileError").hidden = true;
  schedulePreview();
}

fileInput.addEventListener("change", () => {
  releaseOriginal();
  file = fileInput.files[0];
  showImage = false;
  const error = $("#fileError");
  const message = file && (!["image/png", "image/jpeg"].includes(file.type)
    ? "Chọn ảnh định dạng PNG hoặc JPG."
    : file.size > MAX_FILE_SIZE ? "Ảnh vượt quá 5 MB. Chọn ảnh nhỏ hơn." : "");
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
});

form.addEventListener("input", (event) => {
  if (event.target === fileInput) return;
  updateFormLabels();
  schedulePreview({ keepImage: true });
});
form.addEventListener("submit", (event) => { event.preventDefault(); });
$("#resetSettings").onclick = () => {
  // Reset only settings. The file input is associated with this form.
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

$("#autoBtn").onclick = async () => {
  const controller = new AbortController();
  tuneRequest = controller;
  const panel = $("#autoResult");
  panel.textContent = "Đang so sánh độ khớp và thời gian vẽ…";
  syncActions();
  try {
    const result = await api("/drawings/auto", {
      method: "POST", body: uploadData(readParams(), app.selectedMachine), signal: controller.signal,
    });
    if (tuneRequest !== controller) return;
    candidates = result.candidates;
    const elapsed = (result.ms / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 1 });
    const same = candidates.length === 2 && JSON.stringify(candidates[0].params) === JSON.stringify(candidates[1].params);
    panel.innerHTML = `<small class="muted">Đã thử ${result.tried} cấu hình trong ${elapsed} giây.${result.timeLimited ? " Đã hết thời gian tìm." : ""}</small>`
      + (same ? '<small class="muted">Hai lựa chọn cho cùng cấu hình ở ảnh này.</small>' : "")
      + candidates.map((c, i) => `
        <div class="cand">
          <small>${MODE_VI[c.params.mode]} · chi tiết ${c.params.detail} · mượt ${c.params.smoothing}</small>
          <small>Trùng diện tích nét ${c.metrics.iou}% · giữ ${c.metrics.coverage}% nét</small>
          <small>Ước tính ${c.metrics.minutes.toLocaleString("vi-VN")} phút · ${c.metrics.paths} lượt đi nét</small>
          <button type="button" class="small" data-cand="${i}" aria-pressed="false">${esc(c.label)}</button>
        </div>`).join("");
  } catch (err) {
    if (tuneRequest === controller) panel.textContent = err.message;
  } finally {
    if (tuneRequest === controller) { tuneRequest = null; syncActions(); }
  }
};

$("#autoResult").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-cand]");
  if (!button) return;
  const { params } = candidates[+button.dataset.cand];
  form.detail.value = params.detail;
  form.mode.value = params.mode;
  form.smoothing.value = params.smoothing;
  form.simplifyMm.value = params.simplifyMm ?? "";
  form.hatchRatio.value = params.hatchRatio;
  form.despeckle.checked = params.despeckle;
  form.penUp.value = params.penUp;
  form.penDown.value = params.penDown;
  $$("#autoResult [data-cand]").forEach((choice) => {
    choice.classList.toggle("primary", choice === button);
    choice.setAttribute("aria-pressed", String(choice === button));
  });
  form.thresholdMode.value = params.threshold === "adaptive" ? "adaptive" : "manual";
  if (params.threshold !== "adaptive") form.threshold.value = params.threshold;
  form.invert.value = String(params.invert);
  updateFormLabels();
  showImage = false;
  schedulePreview({ delay: 0, keepCandidates: true, keepImage: true });
});

$("#downloadBtn").onclick = () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([preview.gcode], { type: "text/plain" }));
  link.download = file.name.replace(/\.[^.]+$/, "") + ".gcode";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

$("#showSentJob").onclick = () => showTab("jobs");
$("#sendBtn").onclick = async () => {
  if (sending || sentJob || !preview || !app.selectedMachine) return;
  const current = revision;
  const token = app.token;
  const machineId = app.selectedMachine;
  const { previewHash, requestParams } = preview;
  sending = true;
  $("#sendMsg").textContent = "Đang lưu và gửi bản vẽ…";
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
      $("#sendMsg").textContent = `Phiên #${job.id} đã vào hàng đợi của ${job.machine_name}.`;
    } else if (app.token === token) {
      toast(`Phiên #${job.id} đã vào hàng đợi của ${job.machine_name}.`, "ok");
    }
  } catch (err) {
    if (current === revision) {
      if (err.status === 409 && !savedDrawingId) {
        // Resync the workspace before making an updated snapshot sendable.
        await loadMachines().catch(() => {});
        if (app.token !== token) return;
        schedulePreview({ delay: 0 });
      }
      $("#sendMsg").textContent = err.message;
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
  if (!app.machines.length) {
    container.innerHTML = '<p class="muted">Chưa có máy nhận bản vẽ.</p>';
    return;
  }
  container.innerHTML = `
    <label>Chọn máy
      <select id="machineSelect">
        <option value="" disabled ${app.selectedMachine ? "" : "selected"}>Chọn máy nhận</option>
        ${app.machines.map((m) => `<option value="${esc(m.id)}" ${app.selectedMachine === m.id ? "selected" : ""}>${esc(m.name)} · ${esc(m.id)}</option>`).join("")}
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
    <div class="machine-meta"><span>${m.work_width} × ${m.work_height} mm</span>${badge(m.state)}</div>
    ${m.online ? "" : '<p class="muted option-hint">Bản vẽ sẽ chờ máy kết nối lại.</p>'}` : '<p class="muted option-hint">Chọn máy để gửi bản vẽ.</p>';
}

function renderMachineCards() {
  $("#machineCards").innerHTML = app.machines.map((m) => `
    <div class="card">
      <div class="row-between"><h2>${esc(m.name)}</h2>${badge(m.state)}</div>
      <p class="muted">Mã: <code>${esc(m.id)}</code><br/>Vùng vẽ: ${m.work_width}×${m.work_height} mm<br/>
      Phiên chờ: ${m.queued}<br/>Nhịp tim cuối: ${m.last_seen ? new Date(m.last_seen).toLocaleTimeString() : "—"}</p>
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
  jobsBody.innerHTML = jobs.map(jobRow).join("") || `<tr><td colspan="8" class="muted">Chưa có phiên nào.</td></tr>`;
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
    <td>${j.id}</td><td><button class="job-name" type="button" data-details="${j.id}">${esc(j.drawing_name)}</button><small class="job-ref">Phiên #${j.id} · ${esc(j.machine_name)}</small></td><td>${esc(j.machine_name)}</td><td>${esc(j.username)}</td>
    <td>${badge(j.status)}${j.error ? `<br/><small class="error">${esc(j.error)}</small>` : ""}</td>
    <td><div class="bar"><span style="width:${progress}%"></span></div><small>${progress}%</small></td>
    <td><small>${formatDate(j.created_at)}</small></td><td><div class="job-actions">${actions}</div></td></tr>`;
}

function formatDate(value) {
  return new Date(value.endsWith("Z") ? value : value + "Z").toLocaleString("vi-VN");
}

let detailsRequest = 0;
async function openJobDetails(id) {
  const request = ++detailsRequest;
  const body = $("#jobDetailsBody");
  $("#jobDetailsTitle").textContent = `Phiên #${id}`;
  body.textContent = "Đang tải chi tiết…";
  jobDetails.showModal();
  try {
    const { job, events } = await api(`/jobs/${id}`);
    if (request !== detailsRequest || !jobDetails.open) return;
    body.innerHTML = `<p><strong>${esc(job.drawing_name)}</strong> ${badge(job.status)}</p>
      <p class="muted">${esc(job.machine_name)} · ${esc(job.username)} · ${formatDate(job.created_at)}</p>
      <h3>Nhật ký phiên</h3>
      ${events.length ? `<ol class="job-events">${events.map((event) => `<li><time>${formatDate(event.created_at)}</time>
        <span>${esc(STATUS_VI[event.event] || event.event)}${event.detail ? ` · ${esc(event.detail)}` : ""}</span></li>`).join("")}</ol>`
      : '<p class="muted">Chưa có sự kiện.</p>'}`;
  } catch (err) {
    if (request === detailsRequest && jobDetails.open) body.textContent = err.message;
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
    if (updated) replaceJobRow(updated);
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
    <td>${m.work_width}×${m.work_height}</td><td><code>${esc(m.token)}</code></td>
    <td><button class="small" data-m="${esc(m.id)}" data-a="home">Về gốc</button>
        <button class="small" data-m="${esc(m.id)}" data-a="token">Cấp token mới</button>
        <button class="small" data-m="${esc(m.id)}" data-a="toggle" data-en="${m.enabled}">${m.enabled ? "Tắt" : "Bật"}</button></td></tr>`).join("");
  $("#admUsers").innerHTML = users.map((u) => `<tr>
    <td>${u.id}</td><td>${esc(u.username)}</td><td>${u.role}</td><td>${u.locked ? badge("FAILED").replace("Lỗi", "Đã khóa") : badge("IDLE").replace("Rảnh", "Hoạt động")}</td>
    <td><button class="small ${u.locked ? "" : "danger"}" data-u="${u.id}" data-locked="${u.locked}">${u.locked ? "Mở khóa" : "Khóa"}</button></td></tr>`).join("");
  $("#admQueue").innerHTML = jobs.map((j) => `<tr><td>${j.id}</td><td>${esc(j.machine_id)}</td><td>${esc(j.drawing_name)}</td><td>${esc(j.username)}</td><td>${badge(j.status)}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted">Hàng đợi trống.</td></tr>`;
}

$("#admMachines").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-m]");
  if (!b) return;
  try {
    if (b.dataset.a === "home") { await api(`/admin/machines/${b.dataset.m}/home`, { method: "POST" }); toast("Đã gửi lệnh về gốc"); }
    if (b.dataset.a === "token" && confirm("Cấp token mới? Máy phải cập nhật token mới mới kết nối lại được.")) {
      await api(`/admin/machines/${b.dataset.m}/token`, { method: "POST" });
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
  try { const { machine } = await api("/admin/machines", { method: "POST", json: f }); toast(`Đã thêm ${machine.id}, token: ${machine.token}`, "ok"); e.target.reset(); loadAdmin(); loadMachines(); }
  catch (err) { toast(err.message, "err"); }
});

$("#addUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try { await api("/admin/users", { method: "POST", json: f }); toast(`Đã tạo ${f.username}`, "ok"); e.target.reset(); loadAdmin(); }
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
    if (type === "job.completed") toast(`✔ Phiên #${data.id} (${data.drawing_name}) đã vẽ xong trên ${data.machine_name}`, "ok");
    if (type === "job.failed") toast(`✖ Phiên #${data.id} lỗi: ${data.error}`, "err");
  };
}

function onMachineStatus(m) {
  const i = app.machines.findIndex((x) => x.id === m.id);
  if (i >= 0) app.machines[i] = { ...app.machines[i], ...m };
  renderMachineInfo(); renderMachineCards();
  if (m.state === "OFFLINE") toast(`Máy ${m.name} mất kết nối (${m.reason})`, "warn");
  if (m.event === "ERROR") toast(`Máy ${m.name}: ${m.error}`, "err");
  if (!$("#tab-admin").classList.contains("hidden")) loadAdmin();
}

function onJobStatus(j) {
  if (!replaceJobRow(j) && !$("#tab-jobs").classList.contains("hidden")) loadJobs().catch((err) => toast(err.message, "err"));
  if (!$("#tab-admin").classList.contains("hidden")) loadAdmin();
}

// ---------------- Boot ----------------
if (app.token && app.user) enterApp(); else logout();
drawPreview();
