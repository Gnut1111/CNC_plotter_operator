const express = require("express");
const bcrypt = require("bcryptjs");
const config = require("./config");
const { db, validPassword } = require("./db");
const sessions = require("./sessions");
const { addPasswordUser } = require("./accounts");
const googleAuth = require("./google-auth");

function requireAuth(req, res, next) {
  const session = sessions.getSession(sessions.requestSessionId(req));
  if (!session) return res.status(401).json({ error: "Phiên đăng nhập không còn hiệu lực" });
  if (req.get("X-Session-Context") !== sessions.sessionContext(session.session_id)) {
    return res.status(401).json({ error: "Phiên đăng nhập đã thay đổi. Vui lòng tải lại trang." });
  }
  const { session_id, ...user } = session;
  sessions.recordActivity(session_id);
  req.user = user;
  req.sessionId = session_id;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ error: "Không đủ quyền" });
    next();
  };
}

const router = express.Router();
const lookupUser = db.prepare("SELECT * FROM users WHERE username = ?");
const dummyHash = bcrypt.hashSync("unused-login-placeholder", 10);
const attempts = new Map();
const attemptWindowMs = 5 * 60 * 1000;
const maxAttempts = 20;
const maxAddresses = 4096;
let resetsAt = Date.now() + attemptWindowMs;

function allowLogin(req, res, next) {
  if (config.demoMode && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) {
    return res.status(403).json({ error: "Chế độ demo chỉ cho phép đăng nhập trên máy chạy server." });
  }
  const now = Date.now();
  if (now >= resetsAt) {
    attempts.clear();
    resetsAt = now + attemptWindowMs;
  }
  const count = attempts.get(req.ip) ?? 0;
  if (count >= maxAttempts || (!count && attempts.size >= maxAddresses)) {
    res.set("Retry-After", String(Math.ceil((resetsAt - now) / 1000)));
    return res.status(429).json({ error: "Quá nhiều yêu cầu xác thực. Vui lòng thử lại sau vài phút." });
  }
  attempts.set(req.ip, count + 1);
  next();
}

function finishSession(req, res, user, status = 200) {
  if (user.locked) return res.status(403).json({ error: "Tài khoản đã bị khóa" });
  const { context, conflict } = sessions.createSession(req, res, user.id);
  if (conflict) return res.status(409).json({ error: conflict });
  res.status(status).json({ context, user: { id: user.id, username: user.username, role: user.role } });
}

router.get("/options", (req, res) => res.json({ google: Boolean(googleAuth.available(req)) }));

router.post("/login", allowLogin, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || username.length > 32 || !validPassword(password, 1)) {
    return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu" });
  }
  const user = lookupUser.get(username);
  const matches = bcrypt.compareSync(password, user?.password_hash || dummyHash);
  if (!user?.password_hash || !matches) return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu" });
  finishSession(req, res, user);
});

router.post("/register", allowLogin, (req, res) => {
  if (sessions.getSession(sessions.requestSessionId(req))) {
    return res.status(409).json({ error: "Hãy đăng xuất tài khoản đang dùng trên trình duyệt trước." });
  }
  const { username, password } = req.body || {};
  const user = addPasswordUser(typeof username === "string" ? username.trim() : username, password);
  if (user.error) return res.status(user.status).json({ error: user.error });
  finishSession(req, res, user, 201);
});

googleAuth.mountGoogle(router, allowLogin, finishSession);

router.get("/me", (req, res) => {
  const session = sessions.getSession(sessions.requestSessionId(req));
  if (!session) return res.status(401).json({ error: "Phiên đăng nhập không còn hiệu lực" });
  const { session_id, ...user } = session;
  sessions.recordActivity(session_id);
  res.json({ user, context: sessions.sessionContext(session_id) });
});

router.post("/logout", requireAuth, (req, res) => {
  sessions.logout(req, res);
  res.sendStatus(204);
});

module.exports = { router, requireAuth, requireRole };
