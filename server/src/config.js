const { randomBytes } = require("node:crypto");
const path = require("path");
const { profile } = require("./machine-profile");

const ROOT = path.resolve(__dirname, "..");

module.exports = {
  httpPort: Number(process.env.HTTP_PORT || 3000),
  mqttHost: process.env.MQTT_HOST || "127.0.0.1",
  mqttPort: Number(process.env.MQTT_PORT || 1883),
  embeddedBroker: process.env.EMBEDDED_BROKER !== "false",
  demoMode: process.env.DEMO_MODE === "true",
  httpHost: process.env.HTTP_HOST || "127.0.0.1",
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data"),
  webDir: path.resolve(ROOT, "..", "web"),

  // Tài khoản nội bộ của server khi kết nối vào MQTT broker
  serverMqttUser: "server",
  serverMqttPass: process.env.SERVER_MQTT_PASS || randomBytes(32).toString("hex"),

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
