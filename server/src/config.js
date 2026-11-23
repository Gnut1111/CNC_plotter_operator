const path = require("path");
const { profile } = require("./machine-profile");

const ROOT = path.resolve(__dirname, "..");

module.exports = {
  httpPort: Number(process.env.HTTP_PORT || 3000),
  mqttPort: Number(process.env.MQTT_PORT || 1883),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  jwtExpiresIn: "8h",
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data"),
  webDir: path.resolve(ROOT, "..", "web"),

  // Tài khoản nội bộ của server khi kết nối vào MQTT broker
  serverMqttUser: "server",
  serverMqttPass: process.env.SERVER_MQTT_PASS || "server-secret",

  upload: {
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: ["image/png", "image/jpeg"],
  },

  workArea: profile.workArea,

  transfer: {
    chunkSize: 2048, // byte mỗi gói file qua MQTT
    fileAckTimeoutMs: 30000,
  },

  heartbeat: {
    intervalMs: 5000, // máy gửi nhịp tim mỗi 5 s
    timeoutMs: 15000, // quá 15 s không có nhịp tim → OFFLINE
  },
};
