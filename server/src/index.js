const http = require("node:http");
const express = require("express");
const config = require("./config");

async function start() {
  if (!config.embeddedBroker && !process.env.SERVER_MQTT_PASS) {
    throw new Error("Đặt SERVER_MQTT_PASS khi dùng MQTT broker ngoài.");
  }
  const { startBroker, portError } = require("./mqttBroker");
  const { sameOrigin } = require("./sessions");
  if (config.embeddedBroker) await startBroker();

  const auth = require("./auth");
  const api = require("./api");
  const realtime = require("./realtime");
  const statusService = require("./statusService");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req, req.protocol)) {
      return res.status(403).json({ error: "Yêu cầu từ trang khác bị từ chối" });
    }
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use("/api/auth", auth.router);
  app.use("/api", api);
  app.use(express.static(config.webDir));

  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err.code === "LIMIT_FILE_SIZE") {
      status = 413;
      message = `File vượt quá ${config.upload.maxBytes / 1024 / 1024} MB`;
    } else if (err.name === "MulterError") {
      status = 400;
      message = "Yêu cầu tải ảnh không hợp lệ";
    }
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "Lỗi máy chủ" : message });
  });

  const server = http.createServer(app);
  server.on("error", (e) => portError(e, config.httpPort, "HTTP_PORT"));
  realtime.attach(server, app.get("trust proxy fn"));
  statusService.start();
  server.listen(config.httpPort, config.httpHost, () => console.log(`[http] http://${config.httpHost}:${config.httpPort}`));
}

start().catch((err) => { console.error(err.message); process.exitCode = 1; });
