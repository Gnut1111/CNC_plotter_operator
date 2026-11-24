const { createHash, randomBytes } = require("node:crypto");
const { db } = require("./db");

const cookieName = "pixel2plot_session";
const sessionMs = 8 * 60 * 60 * 1000;
const idleMs = 30 * 60 * 1000;
const insert = db.prepare(`
  INSERT INTO sessions (id, user_id, expires_at, last_seen) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO NOTHING`);
const find = db.prepare(`
  SELECT s.id AS session_id, u.id, u.username, u.role, u.locked
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ? AND s.expires_at > ? AND s.last_seen > ? AND u.locked = 0`);
const remove = db.prepare("DELETE FROM sessions WHERE id = ?");
const removeUser = db.prepare("DELETE FROM sessions WHERE user_id = ?");
const removeExpired = db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?");
const touch = db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ? AND last_seen <= ?");

function requestSessionId(req) {
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((part) => part.startsWith(cookieName + "="));
  const value = cookie?.slice(cookieName.length + 1);
  return /^[0-9a-f]{64}$/.test(value ?? "") ? createHash("sha256").update(value).digest("hex") : null;
}

function createSession(req, res, userId) {
  const current = getSession(requestSessionId(req));
  if (current) {
    if (current.id !== userId) return { conflict: "Hãy đăng xuất tài khoản đang dùng trên trình duyệt này trước." };
    recordActivity(current.session_id);
    return { context: sessionContext(current.session_id) };
  }
  const value = randomBytes(32).toString("hex");
  const id = createHash("sha256").update(value).digest("hex");
  const now = Date.now();
  removeExpired.run(now, now - idleMs);
  if (!insert.run(id, userId, now + sessionMs, now).changes) {
    return { conflict: "Tài khoản đang đăng nhập trên thiết bị khác. Hãy đăng xuất ở đó hoặc nhờ quản trị viên thu hồi phiên." };
  }
  res.cookie(cookieName, value, { ...cookieOptions(req), maxAge: sessionMs });
  return { context: sessionContext(id) };
}

function cookieOptions(req) {
  return { httpOnly: true, secure: req.secure, sameSite: "strict", path: "/" };
}

function logout(req, res) {
  const id = requestSessionId(req);
  if (id) remove.run(id);
  res.clearCookie(cookieName, cookieOptions(req));
}

function getSession(id) {
  const now = Date.now();
  return id ? find.get(id, now, now - idleMs) : undefined;
}

function recordActivity(id) {
  const now = Date.now();
  touch.run(now, id, now - 60_000);
}

function sessionContext(id) {
  return id.slice(0, 32);
}

function revokeUserSessions(userId) {
  removeUser.run(userId);
}

function sameOrigin(req, protocol) {
  const origin = req.headers.origin;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (!origin) return true;
  return origin === `${protocol}://${req.headers.host}`;
}

module.exports = { createSession, getSession, logout, recordActivity, requestSessionId, revokeUserSessions, sameOrigin, sessionContext };
