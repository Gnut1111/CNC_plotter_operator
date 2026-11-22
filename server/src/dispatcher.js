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

const ACTIVE = ["SENDING", "READY", "DRAWING", "PAUSED"];
const FINAL = ["COMPLETED", "CANCELLED", "FAILED"];
const ackTimers = new Map(); // jobId → timeout chờ FILE_OK

function getJob(id) {
  return db.prepare(`
    SELECT j.*, d.name AS drawing_name, u.username, m.name AS machine_name
    FROM jobs j JOIN drawings d ON d.id = j.drawing_id
    JOIN users u ON u.id = j.user_id JOIN machines m ON m.id = j.machine_id
    WHERE j.id = ?`).get(id);
}

function logEvent(jobId, event, detail = null) {
  db.prepare("INSERT INTO job_events (job_id, event, detail) VALUES (?, ?, ?)").run(jobId, event, detail);
}

/** Cập nhật trạng thái phiên + ghi lịch sử + đẩy sự kiện realtime */
function setJob(jobId, fields, event) {
  const keys = Object.keys(fields);
  if (FINAL.includes(fields.status)) { keys.push("finished_at"); fields.finished_at = new Date().toISOString(); }
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
function enqueue({ drawingId, machineId, userId }) {
  const r = db.prepare("INSERT INTO jobs (drawing_id, machine_id, user_id) VALUES (?, ?, ?)").run(drawingId, machineId, userId);
  const jobId = Number(r.lastInsertRowid);
  logEvent(jobId, "QUEUED");
  const job = getJob(jobId);
  realtime.emit("job.status", job, userId);
  tryDispatch(machineId);
  return getJob(jobId);
}

/** Nếu máy rảnh và trực tuyến → lấy phiên QUEUED cũ nhất và gửi xuống */
async function tryDispatch(machineId) {
  const m = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId);
  if (!m || !m.online || !m.enabled || m.state !== "IDLE") return;
  if (activeJob(machineId)) return;
  const next = db.prepare("SELECT * FROM jobs WHERE machine_id = ? AND status = 'QUEUED' ORDER BY id LIMIT 1").get(machineId);
  if (!next) return;

  const drawing = db.prepare("SELECT * FROM drawings WHERE id = ?").get(next.drawing_id);
  const data = fs.readFileSync(drawing.gcode_path);
  const size = config.transfer.chunkSize;
  const total = Math.ceil(data.length / size);
  setJob(next.id, { status: "SENDING", progress: 0 }, "SENDING");

  try {
    await publish(topics.cmd(machineId), {
      cmd: "START_JOB", jobId: next.id, size: data.length, chunks: total, crc32: zlib.crc32(data),
    });
    for (let seq = 0; seq < total; seq++) {
      const chunk = data.subarray(seq * size, (seq + 1) * size);
      await publish(topics.file(machineId), {
        jobId: next.id, seq, total, crc32: zlib.crc32(chunk), data: chunk.toString("base64"),
      });
    }
    logEvent(next.id, "FILE_SENT", `${total} chunks, ${data.length} bytes`);
    ackTimers.set(next.id, setTimeout(() => {
      const j = db.prepare("SELECT status FROM jobs WHERE id = ?").get(next.id);
      if (j?.status === "SENDING") setJob(next.id, { status: "FAILED", error: "Hết thời gian chờ FILE_OK" }, "TIMEOUT");
    }, config.transfer.fileAckTimeoutMs));
  } catch (e) {
    setJob(next.id, { status: "FAILED", error: `Lỗi gửi MQTT: ${e.message}` }, "SEND_ERROR");
  }
}

/** Gọi từ Status Service khi nhận bản tin trạng thái có gắn jobId/event */
function onMachineEvent(machineId, msg) {
  const jobId = Number(msg.jobId);
  const job = jobId ? db.prepare("SELECT * FROM jobs WHERE id = ? AND machine_id = ?").get(jobId, machineId) : null;

  if (job && !FINAL.includes(job.status)) {
    const clearAck = () => { clearTimeout(ackTimers.get(jobId)); ackTimers.delete(jobId); };
    switch (msg.event) {
      case "FILE_OK": clearAck(); logEvent(jobId, "FILE_OK"); break;
      case "FILE_ERROR": clearAck(); setJob(jobId, { status: "FAILED", error: `Máy báo lỗi file: ${msg.error || "CRC"}` }, "FILE_ERROR"); break;
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
  if (msg.state === "IDLE") tryDispatch(machineId);
}

/** Máy mất kết nối: phiên đang truyền file → trả lại hàng đợi; phiên đang vẽ giữ nguyên (máy vẽ tiếp từ file cục bộ) */
function onMachineOffline(machineId) {
  const j = activeJob(machineId);
  if (j && (j.status === "SENDING")) setJob(j.id, { status: "QUEUED", progress: 0 }, "REQUEUED_OFFLINE");
}

// ---------------- Job Control ----------------
async function control(jobId, action) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw httpError(404, "Không tìm thấy phiên");
  const m = db.prepare("SELECT * FROM machines WHERE id = ?").get(job.machine_id);

  if (action === "cancel") {
    if (FINAL.includes(job.status)) throw httpError(409, `Phiên đã ${job.status}`);
    if (job.status === "QUEUED") return setJob(jobId, { status: "CANCELLED" }, "CANCELLED_IN_QUEUE");
    if (!m.online) {
      const r = setJob(jobId, { status: "CANCELLED" }, "CANCELLED_OFFLINE");
      return r;
    }
    await publish(topics.cmd(job.machine_id), { cmd: "CANCEL", jobId });
    logEvent(jobId, "CMD_CANCEL");
    return getJob(jobId);
  }
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
