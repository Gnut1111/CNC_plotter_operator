// MQTT Broker nhúng (aedes): xác thực bằng token máy + phân quyền topic theo từng máy
const net = require("net");
const Aedes = require("aedes");
const config = require("./config");
const { db } = require("./db");

function startBroker() {
  const broker = Aedes();

  // Máy đăng nhập bằng username = mã máy, password = token máy (do Admin cấp)
  broker.authenticate = (client, username, password, done) => {
    const pass = password ? password.toString() : "";
    if (username === config.serverMqttUser && pass === config.serverMqttPass) {
      client.role = "server";
      return done(null, true);
    }
    const m = db.prepare("SELECT id, token, enabled FROM machines WHERE id = ?").get(String(username || ""));
    if (m && m.enabled && m.token === pass && client.id === m.id) {
      client.role = "machine";
      client.machineId = m.id;
      return done(null, true);
    }
    const err = new Error("Auth error");
    err.returnCode = 4; // bad username or password
    done(err, false);
  };

  // Máy chỉ được publish lên cnc/<id>/status của chính nó
  broker.authorizePublish = (client, packet, done) => {
    if (!client || client.role === "server") return done(null);
    if (packet.topic === `cnc/${client.machineId}/status`) return done(null);
    done(new Error("Publish not allowed"));
  };

  // Máy chỉ được subscribe cnc/<id>/cmd và cnc/<id>/file của chính nó
  broker.authorizeSubscribe = (client, sub, done) => {
    if (client.role === "server") return done(null, sub);
    const ok = [`cnc/${client.machineId}/cmd`, `cnc/${client.machineId}/file`].includes(sub.topic);
    done(ok ? null : new Error("Subscribe not allowed"), ok ? sub : null);
  };

  const server = net.createServer(broker.handle);
  server.listen(config.mqttPort, () => console.log(`[mqtt] broker listening on :${config.mqttPort}`));
  return broker;
}

module.exports = { startBroker };
