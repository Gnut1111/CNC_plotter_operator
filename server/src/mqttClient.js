// Client MQTT nội bộ của server (kết nối vào broker như một thành viên có quyền đầy đủ)
const mqtt = require("mqtt");
const config = require("./config");

const client = mqtt.connect(process.env.MQTT_URL || `mqtt://127.0.0.1:${config.mqttPort}`, {
  clientId: `server-${process.pid}`,
  username: config.serverMqttUser,
  password: config.serverMqttPass,
  reconnectPeriod: 2000,
});

client.on("connect", () => console.log("[mqtt] server client connected"));
client.on("error", (e) => console.error("[mqtt] client error:", e.message));

const topics = {
  cmd: (id) => `cnc/${id}/cmd`,
  file: (id) => `cnc/${id}/file`,
  status: (id) => `cnc/${id}/status`,
};

module.exports = { client, topics };
