const http = require("http");
const express = require("express");
const config = require("./config");
const { startBroker } = require("./mqttBroker");

if (process.env.EMBEDDED_BROKER !== "false") startBroker();

const auth = require("./auth");
const api = require("./api");
const realtime = require("./realtime");
const statusService = require("./statusService");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", auth.router);
app.use("/api", api);
app.use(express.static(config.webDir));

// Xử lý lỗi chung (multer, converter, job control…)
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err.code === "LIMIT_FILE_SIZE") { status = 413; message = `File vượt quá ${config.upload.maxBytes / 1024 / 1024} MB`; }
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Lỗi máy chủ" : message });
});

const server = http.createServer(app);
realtime.attach(server);
statusService.start();
server.listen(config.httpPort, () => console.log(`[http] http://localhost:${config.httpPort}`));
