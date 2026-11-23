// Status Service: nghe cnc/+/status, đồng bộ trạng thái máy vào CSDL, phát hiện mất kết nối (LWT + nhịp tim)
const config = require("./config");
const { db } = require("./db");
const { client } = require("./mqttClient");
const realtime = require("./realtime");
const dispatcher = require("./dispatcher");

function publicMachine(id) {
  return db.prepare("SELECT id, name, state, online, last_seen, work_width, work_height, enabled, needs_inspection FROM machines WHERE id = ?").get(id);
}

function setOffline(id, reason) {
  db.prepare("UPDATE machines SET online = 0, state = 'OFFLINE' WHERE id = ?").run(id);
  console.log(`[status] ${id} OFFLINE (${reason})`);
  realtime.emit("machine.status", { ...publicMachine(id), reason });
  dispatcher.onMachineOffline(id);
}

function start() {
  client.on("connect", () => client.subscribe("cnc/+/status", { qos: 1 }));

  client.on("message", (topic, buf) => {
    const m = topic.match(/^cnc\/([^/]+)\/status$/);
    if (!m) return;
    const id = m[1];
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!db.prepare("SELECT 1 FROM machines WHERE id = ?").get(id)) return;

    if (msg.state === "OFFLINE") return setOffline(id, msg.event || "LWT");

    const prev = publicMachine(id);
    db.prepare("UPDATE machines SET online = 1, state = ?, last_seen = ? WHERE id = ?")
      .run(String(msg.state || prev.state), new Date().toISOString(), id);
    dispatcher.onMachineEvent(id, msg);
    const cur = publicMachine(id);
    if (!prev.online || prev.state !== cur.state || prev.needs_inspection !== cur.needs_inspection || msg.event && msg.event !== "HEARTBEAT") {
      realtime.emit("machine.status", { ...cur, event: msg.event, error: msg.error });
    }
  });

  // Watchdog nhịp tim
  setInterval(() => {
    const limit = Date.now() - config.heartbeat.timeoutMs;
    for (const m of db.prepare("SELECT id, last_seen FROM machines WHERE online = 1").all()) {
      if (!m.last_seen || Date.parse(m.last_seen) < limit) setOffline(m.id, "HEARTBEAT_TIMEOUT");
    }
  }, 2000);

  // Khởi động server: coi mọi máy là offline cho tới khi nhận bản tin mới
  db.exec("UPDATE machines SET online = 0, state = 'OFFLINE'");
}

module.exports = { start, publicMachine };
