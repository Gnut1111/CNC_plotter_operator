const bcrypt = require("bcryptjs");
const { db, validPassword } = require("./db");

const addUser = db.prepare(`
  INSERT INTO users (username, password_hash, role)
  SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = ? COLLATE NOCASE)
`);
const googleAccount = db.prepare(`
  SELECT u.id, u.username, u.role, u.locked FROM google_accounts g JOIN users u ON u.id = g.user_id
  WHERE g.subject = ?
`);
const addGoogleAccount = db.prepare("INSERT INTO google_accounts (subject, user_id) VALUES (?, ?)");

function addPasswordUser(username, password, role = "user") {
  if (typeof username !== "string" || !/^[a-zA-Z0-9_.]{3,32}$/.test(username) || !validPassword(password)) {
    return { error: "Tên đăng nhập từ 3–32 ký tự, dùng chữ, số, dấu chấm hoặc gạch dưới. Mật khẩu từ 12 ký tự, tối đa 72 byte.", status: 400 };
  }
  const result = addUser.run(username, bcrypt.hashSync(password, 10), role, username);
  if (!result.changes) return { error: "Tên đăng nhập đã được sử dụng.", status: 409 };
  return { id: Number(result.lastInsertRowid), username, role };
}

function findOrCreateGoogleUser(subject, email) {
  db.exec("BEGIN IMMEDIATE");
  try {
    let user = googleAccount.get(subject);
    if (!user) {
      const prefix = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_.]/g, "_").slice(0, 22);
      const base = prefix.length >= 3 ? prefix : "google_user";
      let username = base;
      let nextSuffix = 2;
      let result = addUser.run(username, "", "user", username);
      while (!result.changes) {
        username = `${base}.${nextSuffix++}`;
        result = addUser.run(username, "", "user", username);
      }
      const id = Number(result.lastInsertRowid);
      addGoogleAccount.run(subject, id);
      user = { id, username, role: "user", locked: 0 };
    }
    db.exec("COMMIT");
    return user;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

module.exports = { addPasswordUser, findOrCreateGoogleUser };
