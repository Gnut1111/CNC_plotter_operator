#!/usr/bin/env node
// Máy CNC giả lập qua MQTT — hiện thực đúng giao thức ở docs/mqtt-protocol.md.
// Dùng để demo/kiểm thử web + server khi chưa có phần cứng, và làm "máy thứ 2" cho TC10.
//
//   node sim.js --id sim-01 --token sim-01-token [--url mqtt://localhost:1883] [--speed 60] [--corrupt]
//
// Phím tắt khi đang chạy:  e = nhấn E-Stop | l = chạm công tắc hành trình | o = rút Wi-Fi | c = cắm lại Wi-Fi | q = thoát
const mqtt = require("mqtt");
const zlib = require("zlib");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const ID = args.id || "sim-01";
const TOKEN = args.token || `${ID}-token`;
const URL = args.url || "mqtt://localhost:1883";
const SPEED = Number(args.speed || 60); // dòng G-code / giây
let corruptNext = Boolean(args.corrupt);

const T = { cmd: `cnc/${ID}/cmd`, file: `cnc/${ID}/file`, status: `cnc/${ID}/status` };

const st = { state: "BOOT", jobId: null, progress: 0, lines: [], line: 0, rx: null };
let client;
let drawTimer = null;
let lastPct = -1;

function log(...a) { console.log(`[${ID}]`, ...a); }

const pending = []; // sự kiện phát sinh khi mất mạng — gửi bù khi kết nối lại

function send(extra = {}) {
  const msg = { state: st.state, jobId: st.jobId, progress: st.progress, ts: Date.now(), ...extra };
  if (!client?.connected) {
    if (extra.event && extra.event !== "HEARTBEAT") pending.push(msg);
    return;
  }
  client.publish(T.status, JSON.stringify(msg), { qos: 1 });
}

function setState(state, extra) {
  st.state = state;
  log("→", state, extra?.event || "");
  send(extra);
}

function connect() {
  client = mqtt.connect(URL, {
    clientId: ID, username: ID, password: TOKEN, clean: true, reconnectPeriod: 2000,
    will: { topic: T.status, payload: JSON.stringify({ state: "OFFLINE", event: "LWT" }), qos: 1 },
  });
  client.on("connect", () => {
    log("MQTT connected");
    client.subscribe([T.cmd, T.file], { qos: 1 });
    if (st.state === "BOOT") {
      setState("HOMING");
      setTimeout(() => setState("IDLE", { event: "READY" }), 1000);
    } else {
      while (pending.length) client.publish(T.status, JSON.stringify(pending.shift()), { qos: 1 });
      send({ event: "RECONNECTED" });
    }
  });
  client.on("error", (e) => log("MQTT error:", e.message));
  client.on("message", (topic, buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (topic === T.cmd) onCmd(msg);
    else if (topic === T.file) onChunk(msg);
  });
}

function onCmd(m) {
  log("cmd", m.cmd, m.jobId ?? "");
  switch (m.cmd) {
    case "START_JOB":
      if (st.state !== "IDLE") return send({ event: "FILE_ERROR", jobId: m.jobId, error: `BUSY (${st.state})` });
      st.jobId = m.jobId; st.progress = 0;
      st.rx = { size: m.size, total: m.chunks, crc32: m.crc32, parts: new Array(m.chunks), got: 0 };
      setState("RECEIVING");
      break;
    case "PAUSE":
      if (st.state === "DRAWING" && m.jobId === st.jobId) { stopDrawing(); setState("PAUSED", { event: "PEN_UP" }); }
      break;
    case "RESUME":
      if (st.state === "PAUSED" && m.jobId === st.jobId) { setState("DRAWING"); startDrawing(); }
      break;
    case "CANCEL":
      if (m.jobId === st.jobId) {
        stopDrawing();
        send({ event: "CANCELLED" });
        finishJob();
      }
      break;
    case "HOME":
      if (st.state === "IDLE" || st.state === "ERROR") { setState("HOMING"); setTimeout(() => setState("IDLE"), 1000); }
      break;
  }
}

function onChunk(m) {
  if (st.state !== "RECEIVING" || m.jobId !== st.jobId) return;
  const data = Buffer.from(m.data, "base64");
  let crc = zlib.crc32(data);
  if (corruptNext) { crc ^= 1; corruptNext = false; log("!! giả lập gói hỏng (sai CRC)"); }
  if (crc !== m.crc32) {
    send({ event: "FILE_ERROR", error: `CRC sai ở gói ${m.seq}` });
    return finishJob();
  }
  if (!st.rx.parts[m.seq]) { st.rx.parts[m.seq] = data; st.rx.got++; }
  if (st.rx.got < st.rx.total) return;

  const file = Buffer.concat(st.rx.parts);
  if (file.length !== st.rx.size || zlib.crc32(file) !== st.rx.crc32) {
    send({ event: "FILE_ERROR", error: "CRC toàn file không khớp" });
    return finishJob();
  }
  st.lines = file.toString().split("\n").filter((l) => l && !l.startsWith(";"));
  st.line = 0;
  send({ event: "FILE_OK" });
  setState("READY", { event: "JOB_READY" });
  setTimeout(() => { setState("DRAWING"); startDrawing(); }, 500);
}

function startDrawing() {
  stopDrawing();
  const perTick = Math.max(1, Math.round(SPEED / 10));
  drawTimer = setInterval(() => {
    st.line = Math.min(st.lines.length, st.line + perTick);
    st.progress = Math.round((st.line / st.lines.length) * 1000) / 10;
    const pct = Math.floor(st.progress / 2);
    if (pct !== lastPct) { lastPct = pct; send(); }
    if (st.line >= st.lines.length) {
      stopDrawing();
      send({ event: "JOB_DONE", progress: 100 });
      finishJob();
    }
  }, 100);
}

function stopDrawing() { clearInterval(drawTimer); drawTimer = null; }

function finishJob() {
  st.jobId = null; st.rx = null; st.lines = []; st.line = 0; st.progress = 0; lastPct = -1;
  setState("IDLE");
}

// Nhịp tim mỗi 5 s
setInterval(() => send({ event: "HEARTBEAT" }), 5000);

// Phím tắt mô phỏng sự cố
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (k) => {
    const key = k.toString();
    if (key === "q" || key === "\u0003") process.exit(0);
    if (key === "e" || key === "l") {
      stopDrawing();
      const error = key === "e" ? "E-STOP được nhấn" : "Chạm công tắc hành trình";
      send({ event: "ERROR", error });
      st.jobId = null; st.lines = [];
      setState("ERROR", { error });
      log("Gửi HOME từ trang Admin để về lại IDLE");
    }
    if (key === "o") { log("Rút Wi-Fi (máy vẫn vẽ tiếp file cục bộ)"); client.stream.destroy(); client.options.reconnectPeriod = 0; }
    if (key === "c") { log("Cắm lại Wi-Fi"); client.options.reconnectPeriod = 2000; client.reconnect(); }
  });
}

log(`connecting ${URL} — phím: e=E-Stop, l=Limit, o=offline, c=online, q=thoát`);
connect();
