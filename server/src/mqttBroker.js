// MQTT Broker nhúng (aedes): xác thực bằng token máy + phân quyền topic theo từng máy
const net = require("net");
const config = require("./config");
const { db } = require("./db");

let broker;
const findMachine = db.prepare("SELECT id, token, enabled FROM machines WHERE id = ?");
const serverClientId = `server-${process.pid}`;
const ownOutput = (id, topic) => topic === `cnc/${id}/cmd` || topic === `cnc/${id}/file`;

function machineAuthorized(client) {
  const m = findMachine.get(client.machineId);
  return m?.enabled && m.token === client.machineToken;
}

function disconnectMachine(id) {
  const client = broker?.clients[id];
  if (client?.role === "machine") client.close();
}

async function startBroker() {
  const { Aedes } = await import("aedes");
  broker = await Aedes.createBroker();

  broker.preConnect = (client, packet, done) => {
    const will = packet.will;
    if (!will || (will.topic === `cnc/${packet.clientId}/status` && will.payload.length <= 4096 && !will.retain)) {
      return done(null, true);
    }
    const err = new Error("Invalid will");
    err.returnCode = 5;
    done(err, false);
  };

  // Máy đăng nhập bằng username = mã máy, password = token máy (do Admin cấp)
  broker.authenticate = (client, username, password, done) => {
    const pass = password ? password.toString() : "";
    if (client.id === serverClientId && username === config.serverMqttUser && pass === config.serverMqttPass) {
      client.role = "server";
      return done(null, true);
    }
    const m = findMachine.get(String(username || ""));
    if (m && m.enabled && m.token === pass && client.id === m.id && !m.id.startsWith("server-")) {
      client.role = "machine";
      client.machineId = m.id;
      client.machineToken = pass;
      return done(null, true);
    }
    const err = new Error("Auth error");
    err.returnCode = 4; // bad username or password
    done(err, false);
  };

  // Máy chỉ được publish lên cnc/<id>/status của chính nó
  broker.authorizePublish = (client, packet, done) => {
    if (client?.role === "server") return done(null);
    if (client?.role === "machine" && machineAuthorized(client) && !packet.retain && packet.topic === `cnc/${client.machineId}/status`
        && packet.payload.length <= 4096) return done(null);
    done(new Error("Publish not allowed"));
  };

  // Máy chỉ được subscribe cnc/<id>/cmd và cnc/<id>/file của chính nó
  broker.authorizeSubscribe = (client, sub, done) => {
    if (client.role === "server") return done(null, sub);
    const ok = machineAuthorized(client) && ownOutput(client.machineId, sub.topic);
    done(ok ? null : new Error("Subscribe not allowed"), ok ? sub : null);
  };

  broker.authorizeForward = (client, packet) => {
    if (client.role === "server" || (machineAuthorized(client) && ownOutput(client.machineId, packet.topic))) return packet;
    return null;
  };

  const server = net.createServer(broker.handle);
  server.on("error", (e) => portError(e, config.mqttPort, "MQTT_PORT"));
  server.listen(config.mqttPort, config.mqttHost, () => console.log(`[mqtt] broker listening on ${config.mqttHost}:${config.mqttPort}`));
  return broker;
}

function portError(e, port, envName) {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`\n[LỖI] Cổng ${port} đang bị chương trình khác dùng (có thể là server cũ chưa tắt).`);
  console.error(`  → Xem ai đang dùng:  ss -ltnp | grep ${port}`);
  console.error(`  → Hoặc tắt server cũ: pkill -f "node src/index.js"`);
  console.error(`  → Hoặc đổi cổng:      ${envName}=<cổng khác> npm start\n`);
  process.exit(1);
}

module.exports = { startBroker, portError, disconnectMachine, serverClientId };
