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
  drawing: null, gcode: "", machines: [], selectedMachine: null, ws: null,
};

// ---------------- API ----------------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (res.status === 401 && path !== "/auth/login") { logout(); throw new Error("Phiên đăng nhập hết hạn"); }
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
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
  loadMachines();
  showTab("draw");
}

// ---------------- Tabs ----------------
function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${name}`));
  if (name === "jobs") loadJobs();
  if (name === "machines") loadMachines();
  if (name === "admin") loadAdmin();
}
$$("#tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------------- Image Uploader ----------------
const form = $("#convertForm");
form.detail.oninput = () => ($("#detailVal").textContent = form.detail.value);
form.threshold.oninput = () => ($("#thresholdVal").textContent = form.threshold.value);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = form.image.files[0];
  if (!file) return;
  const params = {
    widthMm: +form.widthMm.value, heightMm: +form.heightMm.value, detail: +form.detail.value,
    threshold: +form.threshold.value, mode: form.mode.value, smoothing: +form.smoothing.value,
    invert: form.invert.checked, drawFeed: +form.drawFeed.value, travelFeed: +form.travelFeed.value,
    penUp: form.penUp.value, penDown: form.penDown.value,
  };
  const fd = new FormData();
  fd.append("image", file);
  fd.append("name", file.name);
  fd.append("params", JSON.stringify(params));
  if (app.selectedMachine) fd.append("machineId", app.selectedMachine);
  $("#convertBtn").disabled = true;
  $("#convertMsg").textContent = "Đang chuyển đổi…";
  try {
    const r = await api("/drawings", { method: "POST", body: fd });
    app.drawing = r.drawing; app.gcode = r.gcode;
    const s = r.drawing.stats;
    $("#stats").textContent = `${s.paths} nét · ${s.lines} dòng G-code · tổng chiều dài vẽ ${s.drawLengthMm} mm · vùng [${s.bbox.join(", ")}] mm`;
    $("#gcodeText").textContent = r.gcode.length > 200000 ? r.gcode.slice(0, 200000) + "\n…" : r.gcode;
    $("#convertMsg").textContent = `Đã tạo bản vẽ #${r.drawing.id}`;
    drawPreview();
    updateSendBtn();
  } catch (err) {
    $("#convertMsg").textContent = "";
    toast(err.message, "err");
  } finally { $("#convertBtn").disabled = false; }
});

// ---------------- G-code Viewer ----------------
function workArea() {
  const m = app.machines.find((x) => x.id === app.selectedMachine);
  return m ? { w: m.work_width, h: m.work_height } : { w: 200, h: 200 };
}

function drawPreview() {
  const cv = $("#preview");
  const ctx = cv.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const { w, h } = workArea();
  const size = 600, pad = 10;
  const k = (size - pad * 2) / Math.max(w, h);
  const X = (x) => pad + x * k, Y = (y) => pad + (h - y) * k; // trục Y máy hướng lên
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "#bbb"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.strokeRect(X(0), Y(h), w * k, h * k);
  ctx.setLineDash([]);
  if (!app.gcode) return;

  const penUp = app.drawing?.params?.penUp || "M5";
  const penDown = app.drawing?.params?.penDown || "M3 S90";
  let x = 0, y = 0, down = false;
  const showTravel = $("#showTravel").checked;
  const strokeCol = css.getPropertyValue("--stroke").trim() || "#000";
  const travelCol = css.getPropertyValue("--travel").trim() || "red";
  ctx.lineWidth = 1.2; ctx.lineCap = "round";
  for (const raw of app.gcode.split("\n")) {
    const line = raw.trim();
    if (line === penUp) { down = false; continue; }
    if (line === penDown) { down = true; continue; }
    const m = line.match(/^G([01])\b/);
    if (!m) continue;
    const nx = +(line.match(/X(-?[\d.]+)/)?.[1] ?? x);
    const ny = +(line.match(/Y(-?[\d.]+)/)?.[1] ?? y);
    const drawing = m[1] === "1" && down;
    if (drawing || showTravel) {
      ctx.beginPath();
      ctx.strokeStyle = drawing ? strokeCol : travelCol;
      ctx.globalAlpha = drawing ? 1 : 0.35;
      ctx.setLineDash(drawing ? [] : [3, 3]);
      ctx.moveTo(X(x), Y(y)); ctx.lineTo(X(nx), Y(ny)); ctx.stroke();
    }
    x = nx; y = ny;
  }
  ctx.globalAlpha = 1; ctx.setLineDash([]);
}
$("#showTravel").onchange = drawPreview;

// ---------------- Machine Selector ----------------
async function loadMachines() {
  const { machines } = await api("/machines");
  app.machines = machines;
  renderMachinePick();
  renderMachineCards();
}

function renderMachinePick() {
  $("#machinePick").innerHTML = app.machines.map((m) => `
    <label class="machine-opt ${m.online ? "" : "disabled"}">
      <input type="radio" name="machine" value="${esc(m.id)}" ${app.selectedMachine === m.id ? "checked" : ""} />
      <span><b>${esc(m.name)}</b> ${badge(m.state)}
      <small>${esc(m.id)} · vùng ${m.work_width}×${m.work_height} mm · ${m.queued} phiên chờ</small></span>
    </label>`).join("") || `<p class="muted">Chưa có máy nào.</p>`;
  $$("#machinePick input").forEach((r) => (r.onchange = () => { app.selectedMachine = r.value; updateSendBtn(); drawPreview(); }));
}

function renderMachineCards() {
  $("#machineCards").innerHTML = app.machines.map((m) => `
    <div class="card">
      <div class="row-between"><h2>${esc(m.name)}</h2>${badge(m.state)}</div>
      <p class="muted">Mã: <code>${esc(m.id)}</code><br/>Vùng vẽ: ${m.work_width}×${m.work_height} mm<br/>
      Phiên chờ: ${m.queued}<br/>Nhịp tim cuối: ${m.last_seen ? new Date(m.last_seen).toLocaleTimeString() : "—"}</p>
    </div>`).join("");
}

function updateSendBtn() { $("#sendBtn").disabled = !(app.drawing && app.selectedMachine); }

$("#sendBtn").onclick = async () => {
  try {
    const { job } = await api("/jobs", { method: "POST", json: { drawingId: app.drawing.id, machineId: app.selectedMachine } });
    $("#sendMsg").textContent = `Đã tạo phiên #${job.id} — ${STATUS_VI[job.status] || job.status}`;
    toast(`Phiên #${job.id} đã vào hàng đợi của ${job.machine_name}`, "ok");
  } catch (err) { toast(err.message, "err"); }
};

// ---------------- Job List + Job Control ----------------
async function loadJobs() {
  const all = $("#allJobs").checked ? "?all=1" : "";
  const { jobs } = await api(`/jobs${all}`);
  $("#jobRows").innerHTML = jobs.map(jobRow).join("") || `<tr><td colspan="8" class="muted">Chưa có phiên nào.</td></tr>`;
}
$("#allJobs").onchange = loadJobs;

function jobRow(j) {
  const btn = (a, label, cls = "") => `<button class="small ${cls}" data-job="${j.id}" data-act="${a}">${label}</button>`;
  const actions = [
    j.status === "DRAWING" && btn("pause", "Tạm dừng"),
    j.status === "PAUSED" && btn("resume", "Tiếp tục"),
    !["COMPLETED", "CANCELLED", "FAILED"].includes(j.status) && btn("cancel", "Hủy", "danger"),
  ].filter(Boolean).join(" ");
  return `<tr id="job-${j.id}">
    <td>${j.id}</td><td>${esc(j.drawing_name)}</td><td>${esc(j.machine_name)}</td><td>${esc(j.username)}</td>
    <td>${badge(j.status)}${j.error ? `<br/><small class="error">${esc(j.error)}</small>` : ""}</td>
    <td><div class="bar"><span style="width:${j.progress}%"></span></div><small>${j.progress}%</small></td>
    <td><small>${new Date(j.created_at + "Z").toLocaleString()}</small></td><td>${actions}</td></tr>`;
}

$("#jobRows").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  b.disabled = true;
  try { await api(`/jobs/${b.dataset.job}/${b.dataset.act}`, { method: "POST" }); }
  catch (err) { toast(err.message, "err"); b.disabled = false; }
});

// ---------------- Admin Dashboard ----------------
async function loadAdmin() {
  if (app.user.role !== "admin") return;
  const [{ machines }, { users }, { jobs }] = await Promise.all([api("/admin/machines"), api("/admin/users"), api("/admin/queue")]);
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
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(app.token)}`);
  app.ws = ws;
  ws.onopen = () => $("#wsDot").classList.add("on");
  ws.onclose = () => {
    $("#wsDot").classList.remove("on");
    if (app.token && app.ws === ws) setTimeout(connectWs, 2000);
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
  renderMachinePick(); renderMachineCards();
  if (m.state === "OFFLINE") toast(`Máy ${m.name} mất kết nối (${m.reason})`, "warn");
  if (m.event === "ERROR") toast(`Máy ${m.name}: ${m.error}`, "err");
  if (!$("#tab-admin").classList.contains("hidden")) loadAdmin();
}

function onJobStatus(j) {
  const row = $(`#job-${j.id}`);
  if (row) row.outerHTML = jobRow(j);
  else if (!$("#tab-jobs").classList.contains("hidden")) loadJobs();
  if (!$("#tab-admin").classList.contains("hidden")) loadAdmin();
}

// ---------------- Boot ----------------
if (app.token && app.user) enterApp(); else logout();
drawPreview();
