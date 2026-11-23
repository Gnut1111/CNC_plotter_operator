// Job Dispatcher + Job Control
// - Hàng đợi FIFO cho từng máy (bảng jobs, status = QUEUED, sắp theo id)
// - Truyền file G-code qua MQTT theo gói có CRC32
// - Xử lý pause / resume / cancel theo trạng thái hiện tại của phiên
const fs = require("fs");
const zlib = require("zlib");
const config = require("./config");
const { db } = require("./db");
const { client, topics } = require("./mqttClient");
const realtime = require("./realtime");
const { machineArea, validateGcode } = require("./machine-profile");

const ACTIVE = ["SENDING", "READY", "DRAWING", "PAUSED"];
const FINAL = ["COMPLETED", "CANCELLED", "FAILED"];
const cancelAttempts = new Map();
const transferStarted = new Map();

function getJob(id) {
  return db.prepare(`
    SELECT j.*, d.name AS drawing_name, u.username, m.name AS machine_name,
      m.online AS machine_online, m.state AS machine_state, m.needs_inspection,
      (SELECT COUNT(*) FROM jobs q WHERE q.machine_id = j.machine_id AND q.id < j.id
        AND q.status IN ('QUEUED','SENDING','READY','DRAWING','PAUSED')) AS ahead
    FROM jobs j JOIN drawings d ON d.id = j.drawing_id
    JOIN users u ON u.id = j.user_id JOIN machines m ON m.id = j.machine_id
    WHERE j.id = ?`).get(id);
}

function logEvent(jobId, event, detail = null) {
  db.prepare("INSERT INTO job_events (job_id, event, detail) VALUES (?, ?, ?)").run(jobId, event, detail);
}

function emitQueueChanged(machineId) {
  const { queued } = db.prepare("SELECT COUNT(*) AS queued FROM jobs WHERE machine_id = ? AND status = 'QUEUED'").get(machineId);
  realtime.emit("queue.changed", { machineId, queued });
}

/** Cập nhật trạng thái phiên + ghi lịch sử + đẩy sự kiện realtime */
function setJob(jobId, fields, event) {
  const keys = Object.keys(fields);
  if (FINAL.includes(fields.status)) {
    keys.push("finished_at", "cancel_requested");
    fields.finished_at = new Date().toISOString();
    fields.cancel_requested = 0;
    transferStarted.delete(jobId);
    cancelAttempts.delete(jobId);
  }
  if (fields.status === "DRAWING") {
    const j = db.prepare("SELECT started_at FROM jobs WHERE id = ?").get(jobId);
    if (!j.started_at) { keys.push("started_at"); fields.started_at = new Date().toISOString(); }
  }
  db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), jobId);
  if (event) logEvent(jobId, event, fields.error || null);
  const job = getJob(jobId);
  realtime.emit("job.status", job, job.user_id);
  if (job.status === "COMPLETED") realtime.emit("job.completed", job, job.user_id);
  if (job.status === "FAILED") realtime.emit("job.failed", job, job.user_id);
  if (job.status === "SENDING" || FINAL.includes(job.status)) emitQueueChanged(job.machine_id);
  return job;
}

function activeJob(machineId) {
  return db.prepare(`SELECT * FROM jobs WHERE machine_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})
    ORDER BY id LIMIT 1`).get(machineId, ...ACTIVE);
}

function publish(topic, payload) {
  return client.publishAsync(topic, JSON.stringify(payload), { qos: 1 });
}

/** Tạo phiên mới và đưa vào hàng đợi của máy */
function enqueue({ drawingId, machineId, userId, requestKey }) {
  const r = db.prepare("INSERT INTO jobs (drawing_id, machine_id, user_id, request_key) VALUES (?, ?, ?, ?)")
    .run(drawingId, machineId, userId, requestKey);
  const jobId = Number(r.lastInsertRowid);
  logEvent(jobId, "QUEUED");
  const job = getJob(jobId);
  realtime.emit("job.status", job, userId);
  emitQueueChanged(machineId);
  tryDispatch(machineId);
  return getJob(jobId);
}

/** Nếu máy rảnh và trực tuyến → lấy phiên QUEUED cũ nhất và gửi xuống */
async function tryDispatch(machineId) {
  const m = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId);
  if (!client.connected || !m || !m.online || !m.enabled || m.needs_inspection || m.state !== "IDLE") return;
  if (activeJob(machineId)) return;
  const oldest = db.prepare(`SELECT j.id, d.gcode_path FROM jobs j JOIN drawings d ON d.id = j.drawing_id
    WHERE j.machine_id = ? AND j.status = 'QUEUED' ORDER BY j.id LIMIT 1`);
  const area = machineArea(m);
  let next, data;
  while ((next = oldest.get(machineId))) {
    try {
      data = fs.readFileSync(next.gcode_path);
      const error = validateGcode(data.toString("utf8"), area);
      if (!error) break;
      setJob(next.id, { status: "FAILED", error }, "MACHINE_PROFILE_MISMATCH");
    } catch (error) {
      setJob(next.id, { status: "FAILED", error: "Không đọc được tệp G-code của phiên." }, "FILE_READ_ERROR");
    }
  }
  if (!next) return;
  const size = config.transfer.chunkSize;
  const total = Math.ceil(data.length / size);
  transferStarted.set(next.id, Date.now());
  setJob(next.id, { status: "SENDING", progress: 0 }, "SENDING");

  try {
    await publish(topics.cmd(machineId), {
      cmd: "START_JOB", jobId: next.id, size: data.length, chunks: total, crc32: zlib.crc32(data),
    });
    for (let seq = 0; seq < total; seq++) {
      if (!transferStarted.has(next.id)) return;
      const chunk = data.subarray(seq * size, (seq + 1) * size);
      await publish(topics.file(machineId), {
        jobId: next.id, seq, total, crc32: zlib.crc32(chunk), data: chunk.toString("base64"),
      });
    }
    logEvent(next.id, "FILE_SENT", `${total} chunks, ${data.length} bytes`);
  } catch (e) {
    // A broker error does not prove that the ESP discarded the file.
    logEvent(next.id, "SEND_ERROR", e.message);
  }
}

function requestMachineCancel(job) {
  const last = cancelAttempts.get(job.id);
  if (last !== undefined && Date.now() - last < config.heartbeat.intervalMs) return;
  cancelAttempts.set(job.id, Date.now());
  publish(topics.cmd(job.machine_id), { cmd: "CANCEL", jobId: job.id })
    .catch((error) => logEvent(job.id, "CANCEL_SEND_ERROR", error.message));
}

/** Gọi từ Status Service khi nhận bản tin trạng thái có gắn jobId/event */
function onMachineEvent(machineId, msg) {
  const jobId = Number(msg.jobId);
  const job = jobId ? db.prepare("SELECT * FROM jobs WHERE id = ? AND machine_id = ?").get(jobId, machineId) : null;

  if (job && !FINAL.includes(job.status)) {
    switch (msg.event) {
      case "FILE_OK": logEvent(jobId, "FILE_OK"); break;
      case "FILE_ERROR": setJob(jobId, { status: "FAILED", error: `Máy báo lỗi file: ${msg.error || "CRC"}` }, "FILE_ERROR"); break;
      case "JOB_READY": setJob(jobId, { status: "READY" }, "JOB_READY"); break;
      case "JOB_DONE": setJob(jobId, { status: "COMPLETED", progress: 100 }, "JOB_DONE"); break;
      case "CANCELLED": setJob(jobId, { status: "CANCELLED" }, "CANCELLED"); break;
      case "ERROR": setJob(jobId, { status: "FAILED", error: msg.error || "Lỗi máy" }, "ERROR"); break;
      default:
        if (msg.state === "DRAWING" && (job.status !== "DRAWING" || msg.progress !== job.progress)) {
          setJob(jobId, { status: "DRAWING", progress: Number(msg.progress) || 0 }, job.status !== "DRAWING" ? "DRAWING" : null);
        } else if (msg.state === "PAUSED" && job.status !== "PAUSED") {
          setJob(jobId, { status: "PAUSED", progress: Number(msg.progress) || job.progress }, "PAUSED");
        }
    }
  }
  const active = activeJob(machineId);
  if (active && jobId === active.id && active.cancel_requested) requestMachineCancel(active);
  if (msg.state !== "IDLE") return;
  if (active) {
    if (msg.jobId !== null) return;
    const sending = active.status === "SENDING";
    const started = transferStarted.get(active.id) ?? Date.parse(active.created_at + "Z");
    if (sending && msg.event !== "READY" && msg.event !== "RECONNECTED"
        && Date.now() - started < config.transfer.fileAckTimeoutMs) return;
    // Explicit empty device state after the previous job was active.
    db.prepare("UPDATE machines SET needs_inspection = 1 WHERE id = ?").run(machineId);
    setJob(active.id, {
      status: "FAILED", error: "Phiên bị gián đoạn. Người tại máy cần kiểm tra giấy trước khi vẽ tiếp.",
    }, "JOB_INTERRUPTED");
    return;
  }
  tryDispatch(machineId);
}

function onMachineOffline(machineId) {
  const job = activeJob(machineId);
  if (job) cancelAttempts.delete(job.id);
}

// ---------------- Job Control ----------------
async function control(jobId, action) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw httpError(404, "Không tìm thấy phiên");
  const m = db.prepare("SELECT * FROM machines WHERE id = ?").get(job.machine_id);

  if (action === "cancel") {
    if (FINAL.includes(job.status)) throw httpError(409, `Phiên đã ${job.status}`);
    if (job.status === "QUEUED") return setJob(jobId, { status: "CANCELLED" }, "CANCELLED_IN_QUEUE");
    if (!job.cancel_requested) setJob(jobId, { cancel_requested: 1 }, "CANCEL_REQUESTED");
    if (m.online) requestMachineCancel(job);
    return getJob(jobId);
  }
  if (job.cancel_requested) throw httpError(409, "Đang chờ máy xác nhận dừng");
  if (!m.online) throw httpError(409, "Máy đang mất kết nối");
  if (action === "pause") {
    if (job.status !== "DRAWING") throw httpError(409, "Chỉ tạm dừng được phiên đang vẽ");
    await publish(topics.cmd(job.machine_id), { cmd: "PAUSE", jobId });
    logEvent(jobId, "CMD_PAUSE");
    return getJob(jobId);
  }
  if (action === "resume") {
    if (job.status !== "PAUSED") throw httpError(409, "Chỉ tiếp tục được phiên đang tạm dừng");
    await publish(topics.cmd(job.machine_id), { cmd: "RESUME", jobId });
    logEvent(jobId, "CMD_RESUME");
    return getJob(jobId);
  }
  throw httpError(400, "Hành động không hợp lệ");
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { enqueue, tryDispatch, onMachineEvent, onMachineOffline, control, getJob, publish };
