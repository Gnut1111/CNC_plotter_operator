const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("node:crypto");
const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const config = require("./config");
const { db, newToken } = require("./db");
const { requireAuth, requireRole } = require("./auth");
const { convert, DEFAULTS } = require("./converter");
const { tuneInWorker } = require("./tune-worker");
const dispatcher = require("./dispatcher");
const { publicMachine } = require("./statusService");

const router = express.Router();
router.use(requireAuth);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------- Drawings (Image Uploader + Converter + Storage) ----------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxBytes },
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
  return m ? { width: m.work_width, height: m.work_height } : config.workArea;
}

router.get("/converter/defaults", (req, res) => res.json({ defaults: DEFAULTS, workArea: config.workArea }));

/** Kiểm tra file tải lên + chạy hàm xử lý ảnh; trả null nếu đã gửi phản hồi lỗi */
async function processUpload(req, res, fn) {
  if (!req.file) { res.status(400).json({ error: "Chưa chọn ảnh" }); return null; }
  if (!isPngOrJpeg(req.file.buffer)) { res.status(400).json({ error: "Nội dung file không phải PNG/JPG hợp lệ" }); return null; }
  try {
    const params = typeof req.body.params === "string" ? JSON.parse(req.body.params || "{}") : {};
    return await fn(req.file.buffer, params, workAreaOf(req.body.machineId));
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

async function convertUpload(req, res) {
  const result = await processUpload(req, res, convert);
  if (!result) return null;
  if (result.stats.paths) return result;
  res.status(422).json({ error: "Không tìm thấy nét vẽ. Thử đổi cách tách nét hoặc đảo màu." });
  return null;
}

const hashGcode = (gcode) => createHash("sha256").update(gcode).digest("hex");

router.post("/drawings/preview", upload.single("image"), wrap(async (req, res) => {
  const result = await convertUpload(req, res);
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
  const rows = db.prepare(`SELECT m.id, m.name, m.state, m.online, m.last_seen, m.work_width, m.work_height,
      (SELECT COUNT(*) FROM jobs j WHERE j.machine_id = m.id AND j.status = 'QUEUED') AS queued
    FROM machines m WHERE m.enabled = 1 ORDER BY m.id`).all();
  res.json({ machines: rows });
});

// ---------------- Jobs (Job List + Job Control) ----------------
router.post("/jobs", (req, res) => {
  const drawingId = Number(req.body.drawingId);
  const machineId = String(req.body.machineId || "");
  const d = db.prepare("SELECT * FROM drawings WHERE id = ?").get(drawingId);
  if (!d || (d.user_id !== req.user.id && req.user.role !== "admin")) return res.status(404).json({ error: "Không tìm thấy bản vẽ" });
  const m = db.prepare("SELECT * FROM machines WHERE id = ? AND enabled = 1").get(machineId);
  if (!m) return res.status(404).json({ error: "Không tìm thấy máy" });
  const job = dispatcher.enqueue({ drawingId, machineId, userId: req.user.id });
  res.status(201).json({ job });
});

router.get("/jobs", (req, res) => {
  const all = req.user.role === "admin" && req.query.all === "1";
  const rows = db.prepare(`
    SELECT j.*, d.name AS drawing_name, u.username, m.name AS machine_name
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

admin.get("/machines", (req, res) => res.json({ machines: db.prepare("SELECT * FROM machines ORDER BY id").all() }));

admin.post("/machines", (req, res) => {
  const id = String(req.body.id || "").trim();
  if (!/^[a-z0-9-]{2,32}$/.test(id)) return res.status(400).json({ error: "Mã máy chỉ gồm a-z, 0-9, '-' (2–32 ký tự)" });
  if (db.prepare("SELECT 1 FROM machines WHERE id = ?").get(id)) return res.status(409).json({ error: "Mã máy đã tồn tại" });
  const token = newToken();
  db.prepare("INSERT INTO machines (id, name, token, work_width, work_height) VALUES (?, ?, ?, ?, ?)")
    .run(id, String(req.body.name || id), token, Number(req.body.workWidth) || 200, Number(req.body.workHeight) || 200);
  res.status(201).json({ machine: db.prepare("SELECT * FROM machines WHERE id = ?").get(id) });
});

admin.patch("/machines/:id", (req, res) => {
  const m = db.prepare("SELECT * FROM machines WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: "Không tìm thấy máy" });
  const name = req.body.name ?? m.name;
  const enabled = req.body.enabled === undefined ? m.enabled : Number(Boolean(req.body.enabled));
  const ww = Number(req.body.workWidth) || m.work_width;
  const wh = Number(req.body.workHeight) || m.work_height;
  db.prepare("UPDATE machines SET name = ?, enabled = ?, work_width = ?, work_height = ? WHERE id = ?").run(name, enabled, ww, wh, m.id);
  res.json({ machine: db.prepare("SELECT * FROM machines WHERE id = ?").get(m.id) });
});

admin.post("/machines/:id/token", (req, res) => {
  const token = newToken();
  const r = db.prepare("UPDATE machines SET token = ? WHERE id = ?").run(token, req.params.id);
  if (!r.changes) return res.status(404).json({ error: "Không tìm thấy máy" });
  res.json({ id: req.params.id, token });
});

admin.post("/machines/:id/home", wrap(async (req, res) => {
  const m = publicMachine(req.params.id);
  if (!m) return res.status(404).json({ error: "Không tìm thấy máy" });
  await dispatcher.publish(`cnc/${m.id}/cmd`, { cmd: "HOME" });
  res.json({ ok: true });
}));

admin.get("/users", (req, res) => res.json({ users: db.prepare("SELECT id, username, role, locked, created_at FROM users ORDER BY id").all() }));

admin.post("/users", (req, res) => {
  const { username, password, role } = req.body || {};
  if (!/^[a-zA-Z0-9_.]{3,32}$/.test(username || "") || String(password || "").length < 6) {
    return res.status(400).json({ error: "Tên 3–32 ký tự, mật khẩu ≥ 6 ký tự" });
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
  if (id === req.user.id && req.body.locked) return res.status(400).json({ error: "Không thể tự khóa chính mình" });
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!u) return res.status(404).json({ error: "Không tìm thấy người dùng" });
  const locked = req.body.locked === undefined ? u.locked : Number(Boolean(req.body.locked));
  const role = ["user", "admin"].includes(req.body.role) ? req.body.role : u.role;
  db.prepare("UPDATE users SET locked = ?, role = ? WHERE id = ?").run(locked, role, id);
  res.json({ ok: true });
});

admin.get("/queue", (req, res) => {
  res.json({ jobs: db.prepare(`SELECT j.id, j.machine_id, j.status, j.progress, u.username, d.name AS drawing_name, j.created_at
    FROM jobs j JOIN users u ON u.id = j.user_id JOIN drawings d ON d.id = j.drawing_id
    WHERE j.status NOT IN ('COMPLETED','CANCELLED','FAILED') ORDER BY j.machine_id, j.id`).all() });
});

router.use("/admin", admin);

module.exports = router;
