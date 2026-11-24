const realtime = require("./realtime");
const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("node:crypto");
const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const config = require("./config");
const { db, newToken, validPassword } = require("./db");
const { requireAuth, requireRole } = require("./auth");
const { getSession, revokeUserSessions } = require("./sessions");
const { disconnectMachine } = require("./mqttBroker");
const { convert, DEFAULTS } = require("./converter");
const { profile, machineArea, validateGcode } = require("./machine-profile");
const { tuneInWorker } = require("./tune-worker");
const dispatcher = require("./dispatcher");
const { publicMachine, setOffline } = require("./statusService");

const router = express.Router();
router.use(requireAuth);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------- Drawings (Image Uploader + Converter + Storage) ----------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxBytes, files: 1, fields: 7, parts: 9 },
  fileFilter: (req, file, cb) => {
    if (!config.upload.mimeTypes.includes(file.mimetype)) {
      const e = new Error("Chỉ chấp nhận ảnh PNG hoặc JPG");
      e.status = 400;
      return cb(e);
    }
    cb(null, true);
  },
});

function isPngOrJpeg(buf) {
  const png = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  return png || jpg;
}

function workAreaOf(machineId) {
  const m = machineId && db.prepare("SELECT work_width, work_height FROM machines WHERE id = ?").get(machineId);
  return m ? machineArea(m) : config.workArea;
}

router.get("/converter/defaults", (req, res) => res.json({ defaults: DEFAULTS, workArea: config.workArea, profile }));

/** Kiểm tra file tải lên + chạy hàm xử lý ảnh; trả null nếu đã gửi phản hồi lỗi */
async function processUpload(req, res, fn) {
  if (!req.file) { res.status(400).json({ error: "Chưa chọn ảnh" }); return null; }
  if (!isPngOrJpeg(req.file.buffer)) { res.status(400).json({ error: "Nội dung file không phải PNG/JPG hợp lệ" }); return null; }
  try {
    const params = typeof req.body.params === "string" ? JSON.parse(req.body.params || "{}") : {};
    const result = await fn(req.file.buffer, params, workAreaOf(req.body.machineId));
    if (res.destroyed) return null;
    if (!getSession(req.sessionId)) {
      res.status(401).json({ error: "Phiên đăng nhập không còn hiệu lực" });
      return null;
    }
    return result;
  } catch (e) {
    if (e.status) throw e;
    res.status(400).json({ error: `Không xử lý được ảnh: ${e.message}` });
    return null;
  }
}

// Tự dò tham số: trả về các phương án (không lưu bản vẽ)
router.post("/drawings/auto", upload.single("image"), wrap(async (req, res) => {
  const result = await processUpload(req, res, (image, params, area) => tuneInWorker(image, params, area, res, req.body.profile ?? "both"));
  if (!result) return;
  if (!result.candidates.length) return res.status(422).json({ error: "Không tìm thấy nét vẽ nào trong ảnh" });
  res.json(result);
}));

async function convertUpload(req, res, { preview = false } = {}) {
  const result = await processUpload(req, res, (image, params, area) => convert(image, params, area, {
    includePaths: preview,
    edits: typeof req.body.edits === "string" ? JSON.parse(req.body.edits) : undefined,
  }));
  if (!result) return null;
  if (result.stats.paths || (preview && result.sourcePaths.length)) return result;
  res.status(422).json({ error: "Không tìm thấy nét vẽ. Thử đổi cách tách nét hoặc đảo màu." });
  return null;
}

const hashGcode = (gcode) => createHash("sha256").update(gcode).digest("hex");

router.post("/drawings/preview", upload.single("image"), wrap(async (req, res) => {
  const result = await convertUpload(req, res, { preview: true });
  if (result) res.json({ ...result, previewHash: hashGcode(result.gcode) });
}));

router.post("/drawings", upload.single("image"), wrap(async (req, res) => {
  const result = await convertUpload(req, res);
  if (!result) return;
  const { gcode, params: used, stats } = result;

  if (req.body.previewHash !== undefined && req.body.previewHash !== hashGcode(gcode)) {
    return res.status(409).json({ error: "Kết quả vẽ đã thay đổi. Kiểm tra bản xem trước rồi gửi lại." });
  }
  const stamp = randomUUID();
  const ext = req.file.mimetype === "image/png" ? ".png" : ".jpg";
  const imagePath = path.join(config.dataDir, "uploads", stamp + ext);
  const gcodePath = path.join(config.dataDir, "gcode", stamp + ".gcode");
  fs.writeFileSync(imagePath, req.file.buffer);
  fs.writeFileSync(gcodePath, gcode);

  const name = String(req.body.name || req.file.originalname || "drawing").slice(0, 100);
  const r = db.prepare("INSERT INTO drawings (user_id, name, image_path, gcode_path, params, stats) VALUES (?, ?, ?, ?, ?, ?)")
    .run(req.user.id, name, imagePath, gcodePath, JSON.stringify(used), JSON.stringify(stats));
  res.status(201).json({ drawing: { id: Number(r.lastInsertRowid), name, params: used, stats }, gcode });
}));

function ownDrawing(req) {
  const d = db.prepare("SELECT * FROM drawings WHERE id = ?").get(Number(req.params.id));
  if (!d || (d.user_id !== req.user.id && req.user.role !== "admin")) return null;
  return d;
}

router.get("/drawings", (req, res) => {
  const rows = db.prepare("SELECT id, name, params, stats, created_at FROM drawings WHERE user_id = ? ORDER BY id DESC LIMIT 50").all(req.user.id);
  res.json({ drawings: rows.map((d) => ({ ...d, params: JSON.parse(d.params), stats: JSON.parse(d.stats) })) });
});

router.get("/drawings/:id/gcode", (req, res) => {
  const d = ownDrawing(req);
  if (!d) return res.status(404).json({ error: "Không tìm thấy bản vẽ" });
  res.type("text/plain").send(fs.readFileSync(d.gcode_path));
});

router.get("/drawings/:id/image", (req, res) => {
  const d = ownDrawing(req);
  if (!d) return res.status(404).json({ error: "Không tìm thấy bản vẽ" });
  res.sendFile(d.image_path);
});

// ---------------- Machines (Machine Selector) ----------------
router.get("/machines", (req, res) => {
  const rows = db.prepare(`SELECT m.id, m.name, m.state, m.online, m.last_seen, m.work_width, m.work_height, m.needs_inspection,
      (SELECT COUNT(*) FROM jobs j WHERE j.machine_id = m.id AND j.status = 'QUEUED') AS queued
    FROM machines m WHERE m.enabled = 1 ORDER BY m.id`).all();
  res.json({ machines: rows });
});

// ---------------- Jobs (Job List + Job Control) ----------------
router.post("/jobs", (req, res) => {
  const drawingId = Number(req.body.drawingId);
  const machineId = String(req.body.machineId || "");
  const requestKey = req.body.requestKey ?? null;
  if (requestKey !== null) {
    if (typeof requestKey !== "string" || !/^[0-9a-f]{32}$/.test(requestKey)) {
      return res.status(400).json({ error: "Mã yêu cầu không hợp lệ" });
    }
    const existing = db.prepare("SELECT id, drawing_id, machine_id FROM jobs WHERE user_id = ? AND request_key = ?")
      .get(req.user.id, requestKey);
    if (existing) {
      if (existing.drawing_id !== drawingId || existing.machine_id !== machineId) {
        return res.status(409).json({ error: "Mã yêu cầu đã được dùng cho bản vẽ khác" });
      }
      return res.json({ job: dispatcher.getJob(existing.id) });
    }
  }
  const d = db.prepare("SELECT * FROM drawings WHERE id = ?").get(drawingId);
  if (!d || (d.user_id !== req.user.id && req.user.role !== "admin")) return res.status(404).json({ error: "Không tìm thấy bản vẽ" });
  const m = db.prepare("SELECT * FROM machines WHERE id = ? AND enabled = 1").get(machineId);
  if (!m) return res.status(404).json({ error: "Không tìm thấy máy" });
  const error = validateGcode(fs.readFileSync(d.gcode_path, "utf8"), machineArea(m));
  if (error) return res.status(409).json({ error });
  const job = dispatcher.enqueue({ drawingId, machineId, userId: req.user.id, requestKey });
  res.status(201).json({ job });
});

router.get("/jobs", (req, res) => {
  const all = req.user.role === "admin" && req.query.all === "1";
  const rows = db.prepare(`
    SELECT j.*, d.name AS drawing_name, u.username, m.name AS machine_name,
      m.online AS machine_online, m.state AS machine_state, m.needs_inspection,
      (SELECT COUNT(*) FROM jobs q WHERE q.machine_id = j.machine_id AND q.id < j.id
        AND q.status IN ('QUEUED','SENDING','READY','DRAWING','PAUSED')) AS ahead
    FROM jobs j JOIN drawings d ON d.id = j.drawing_id JOIN users u ON u.id = j.user_id JOIN machines m ON m.id = j.machine_id
    ${all ? "" : "WHERE j.user_id = ?"} ORDER BY j.id DESC LIMIT 100`).all(...(all ? [] : [req.user.id]));
  res.json({ jobs: rows });
});

router.get("/jobs/:id", (req, res) => {
  const job = dispatcher.getJob(Number(req.params.id));
  if (!job || (job.user_id !== req.user.id && req.user.role !== "admin")) return res.status(404).json({ error: "Không tìm thấy phiên" });
  const events = db.prepare("SELECT event, detail, created_at FROM job_events WHERE job_id = ? ORDER BY id").all(job.id);
  res.json({ job, events });
});

router.post("/jobs/:id/:action(pause|resume|cancel)", wrap(async (req, res) => {
  const job = db.prepare("SELECT user_id FROM jobs WHERE id = ?").get(Number(req.params.id));
  if (!job || (job.user_id !== req.user.id && req.user.role !== "admin")) return res.status(404).json({ error: "Không tìm thấy phiên" });
  res.json({ job: await dispatcher.control(Number(req.params.id), req.params.action) });
}));

// ---------------- Admin Service ----------------
const admin = express.Router();
admin.use(requireRole("admin"));

admin.get("/machines", (req, res) => {
  const machines = db.prepare("SELECT id FROM machines ORDER BY id").all().map(({ id }) => publicMachine(id));
  res.json({ machines });
});

admin.get("/machines/:id/token", (req, res) => {
  const machine = db.prepare("SELECT token FROM machines WHERE id = ?").get(req.params.id);
  if (!machine) return res.status(404).json({ error: "Không tìm thấy máy" });
  res.json(machine);
});

function machineBusy(id) {
  return db.prepare("SELECT 1 FROM jobs WHERE machine_id = ? AND status IN ('SENDING','READY','DRAWING','PAUSED') LIMIT 1").get(id);
}

function revokeMachineConnection(machine) {
  disconnectMachine(machine.id);
  if (machine.online) setOffline(machine.id, "ACCESS_REVOKED");
}

function configuredArea(input, fallback) {
  const width = input.workWidth === undefined ? fallback.width : Number(input.workWidth);
  const height = input.workHeight === undefined ? fallback.height : Number(input.workHeight);
  if (!(width >= 1 && width <= profile.workArea.width && height >= 1 && height <= profile.workArea.height)) return null;
  return { width, height };
}

admin.post("/machines", (req, res) => {
  const id = String(req.body.id || "").trim();
  if (id.startsWith("server-")) return res.status(400).json({ error: "Tiền tố server- dành cho kết nối nội bộ." });
  if (!/^[a-z0-9-]{2,32}$/.test(id)) return res.status(400).json({ error: "Mã máy chỉ gồm a-z, 0-9, '-' (2–32 ký tự)" });
  if (db.prepare("SELECT 1 FROM machines WHERE id = ?").get(id)) return res.status(409).json({ error: "Mã máy đã tồn tại" });
  const area = configuredArea(req.body, profile.workArea);
  if (!area) return res.status(400).json({ error: "Vùng máy HTrang tối đa 120 × 80 mm, mỗi cạnh tối thiểu 1 mm." });
  const token = newToken();
  db.prepare("INSERT INTO machines (id, name, token, work_width, work_height) VALUES (?, ?, ?, ?, ?)")
    .run(id, String(req.body.name || id), token, area.width, area.height);
  res.status(201).json({ machine: publicMachine(id) });
});

admin.patch("/machines/:id", (req, res) => {
  const m = db.prepare("SELECT * FROM machines WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: "Không tìm thấy máy" });
  const name = req.body.name ?? m.name;
  if (req.body.enabled !== undefined && typeof req.body.enabled !== "boolean") {
    return res.status(400).json({ error: "Trạng thái bật/tắt phải là true hoặc false." });
  }
  const enabled = req.body.enabled === undefined ? m.enabled : Number(req.body.enabled);
  if (enabled !== m.enabled && !config.embeddedBroker) {
    return res.status(409).json({ error: "Thay quyền kết nối của máy tại MQTT broker ngoài." });
  }
  const area = configuredArea(req.body, machineArea(m));
  if (!area) return res.status(400).json({ error: "Vùng máy HTrang tối đa 120 × 80 mm, mỗi cạnh tối thiểu 1 mm." });
  if (m.enabled && !enabled && machineBusy(m.id)) {
    return res.status(409).json({ error: "Chờ phiên vẽ kết thúc trước khi tắt quyền kết nối của máy." });
  }
  db.prepare("UPDATE machines SET name = ?, enabled = ?, work_width = ?, work_height = ? WHERE id = ?").run(name, enabled, area.width, area.height, m.id);
  if (m.enabled && !enabled) revokeMachineConnection(m);
  res.json({ machine: publicMachine(m.id) });
});

admin.post("/machines/:id/token", (req, res) => {
  const machine = publicMachine(req.params.id);
  if (!machine) return res.status(404).json({ error: "Không tìm thấy máy" });
  if (!config.embeddedBroker) return res.status(409).json({ error: "Đổi token của máy tại MQTT broker ngoài." });
  if (machineBusy(machine.id)) return res.status(409).json({ error: "Chờ phiên vẽ kết thúc trước khi đổi token máy." });
  db.prepare("UPDATE machines SET token = ? WHERE id = ?").run(newToken(), machine.id);
  revokeMachineConnection(machine);
  res.sendStatus(204);
});

admin.post("/machines/:id/home", wrap(async (req, res) => {
  const m = publicMachine(req.params.id);
  if (!m) return res.status(404).json({ error: "Không tìm thấy máy" });
  await dispatcher.publish(`cnc/${m.id}/cmd`, { cmd: "HOME" });
  res.json({ ok: true });
}));

admin.post("/machines/:id/inspection", (req, res) => {
  const m = publicMachine(req.params.id);
  if (!m) return res.status(404).json({ error: "Không tìm thấy máy" });
  if (!m.online || m.state !== "IDLE") return res.status(409).json({ error: "Máy phải trực tuyến và ở trạng thái rảnh." });
  if (m.needs_inspection) {
    db.prepare("UPDATE machines SET needs_inspection = 0 WHERE id = ?").run(m.id);
    realtime.emit("machine.status", publicMachine(m.id));
    dispatcher.tryDispatch(m.id);
  }
  res.json({ ok: true });
});

admin.get("/users", (req, res) => res.json({ users: db.prepare("SELECT id, username, role, locked, created_at FROM users ORDER BY id").all() }));

admin.post("/users", (req, res) => {
  const { username, password, role } = req.body || {};
  if (typeof username !== "string" || !/^[a-zA-Z0-9_.]{3,32}$/.test(username) || !validPassword(password)) {
    return res.status(400).json({ error: "Tên đăng nhập 3–32 ký tự, mật khẩu ít nhất 12 ký tự và tối đa 72 byte." });
  }
  try {
    const r = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
      .run(username, bcrypt.hashSync(password, 10), role === "admin" ? "admin" : "user");
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: "Tên đăng nhập đã tồn tại" });
  }
});

admin.patch("/users/:id", (req, res) => {
  const id = Number(req.params.id);
  if ((req.body.locked !== undefined && typeof req.body.locked !== "boolean")
      || (req.body.role !== undefined && !["user", "admin"].includes(req.body.role))) {
    return res.status(400).json({ error: "Trạng thái khóa hoặc vai trò không hợp lệ." });
  }
  if (id === req.user.id && (req.body.locked || req.body.role === "user")) {
    return res.status(400).json({ error: "Không thể tự khóa hoặc hạ quyền quản trị của mình." });
  }
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!u) return res.status(404).json({ error: "Không tìm thấy người dùng" });
  const locked = req.body.locked === undefined ? u.locked : Number(req.body.locked);
  const role = req.body.role ?? u.role;
  db.prepare("UPDATE users SET locked = ?, role = ? WHERE id = ?").run(locked, role, id);
  res.json({ ok: true });
});

admin.post("/users/:id/revoke-sessions", (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return res.status(404).json({ error: "Không tìm thấy người dùng" });
  revokeUserSessions(id);
  res.sendStatus(204);
});

admin.post("/users/:id/password", (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  if (!validPassword(password)) {
    return res.status(400).json({ error: "Mật khẩu cần ít nhất 12 ký tự và tối đa 72 byte." });
  }
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return res.status(404).json({ error: "Không tìm thấy người dùng" });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), id);
  res.sendStatus(204);
});

admin.get("/queue", (req, res) => {
  res.json({ jobs: db.prepare(`SELECT j.id, j.machine_id, j.status, j.progress, u.username, d.name AS drawing_name, j.created_at
    FROM jobs j JOIN users u ON u.id = j.user_id JOIN drawings d ON d.id = j.drawing_id
    WHERE j.status NOT IN ('COMPLETED','CANCELLED','FAILED') ORDER BY j.machine_id, j.id`).all() });
});

router.use("/admin", admin);

module.exports = router;
