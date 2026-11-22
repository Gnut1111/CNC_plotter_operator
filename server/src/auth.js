const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("./config");
const { db } = require("./db");

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

// Auth Middleware: kiểm tra JWT, tài khoản còn hoạt động
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Thiếu token" });
  try {
    const payload = verifyToken(token);
    const user = db.prepare("SELECT id, username, role, locked FROM users WHERE id = ?").get(payload.sub);
    if (!user || user.locked) return res.status(401).json({ error: "Tài khoản không hợp lệ hoặc đã bị khóa" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Token không hợp lệ hoặc đã hết hạn" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ error: "Không đủ quyền" });
    next();
  };
}

const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || ""));
  if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu" });
  }
  if (user.locked) return res.status(403).json({ error: "Tài khoản đã bị khóa" });
  res.json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

module.exports = { router, requireAuth, requireRole, verifyToken };
