const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

fs.mkdirSync(path.join(config.dataDir, "uploads"), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, "gcode"), { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, "cnc.db"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user','admin')),
  locked        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machines (
  id          TEXT PRIMARY KEY,           -- vd: cnc-01 (dùng trong topic MQTT)
  name        TEXT NOT NULL,
  token       TEXT NOT NULL,              -- mật khẩu MQTT của máy
  state       TEXT NOT NULL DEFAULT 'OFFLINE',
  online      INTEGER NOT NULL DEFAULT 0,
  last_seen   TEXT,
  work_width  REAL NOT NULL DEFAULT ${config.workArea.width},
  work_height REAL NOT NULL DEFAULT ${config.workArea.height},
  enabled     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS drawings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  image_path  TEXT NOT NULL,
  gcode_path  TEXT NOT NULL,
  params      TEXT NOT NULL,              -- JSON tham số chuyển đổi
  stats       TEXT NOT NULL,              -- JSON: số nét, số dòng, chiều dài
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  drawing_id   INTEGER NOT NULL REFERENCES drawings(id),
  machine_id   TEXT NOT NULL REFERENCES machines(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'QUEUED',
  -- QUEUED → SENDING → READY → DRAWING ⇄ PAUSED → COMPLETED | CANCELLED | FAILED
  progress     REAL NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs(id),
  event      TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

for (const [table, column, type] of [
  ["jobs", "request_key", "TEXT"],
  ["jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0"],
  ["machines", "needs_inspection", "INTEGER NOT NULL DEFAULT 0"],
]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((field) => field.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS jobs_user_request ON jobs(user_id, request_key)");

// Dữ liệu mẫu cho lần chạy đầu tiên
function seed() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return;
  const insertUser = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)");
  insertUser.run("admin", bcrypt.hashSync("admin123", 10), "admin");
  insertUser.run("user", bcrypt.hashSync("user123", 10), "user");

  const insertMachine = db.prepare("INSERT INTO machines (id, name, token, work_width, work_height) VALUES (?, ?, ?, ?, ?)");
  insertMachine.run("cnc-01", "Máy vẽ thật #1", "cnc-01-token", config.workArea.width, config.workArea.height);
  insertMachine.run("sim-01", "Máy giả lập #1", "sim-01-token", config.workArea.width, config.workArea.height);
  console.log("[db] seeded: admin/admin123, user/user123, machines cnc-01, sim-01");
}
seed();
db.prepare(`UPDATE machines SET work_width = max(1, min(work_width, ?)), work_height = max(1, min(work_height, ?))
  WHERE work_width NOT BETWEEN 1 AND ? OR work_height NOT BETWEEN 1 AND ?`)
  .run(config.workArea.width, config.workArea.height, config.workArea.width, config.workArea.height);

function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

module.exports = { db, newToken };
