// Realtime Hub: dùng cùng phiên đăng nhập với REST API.
const { WebSocketServer } = require("ws");
const { getSession, requestSessionId, sameOrigin, sessionContext } = require("./sessions");

const clients = new Set();

function activeSession(ws) {
  const session = getSession(ws.sessionId);
  if (session) return session;
  clients.delete(ws);
  ws.close(4001, "unauthorized");
}

function attach(httpServer, trustProxy) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 1024,
    verifyClient: ({ req, secure }, done) => {
      const forwarded = trustProxy(req.socket.remoteAddress) && req.headers["x-forwarded-proto"]?.split(",")[0].trim();
      const allowed = Boolean(req.headers.origin) && sameOrigin(req, secure || forwarded === "https" ? "https" : "http");
      done(allowed, 403);
    },
  });
  wss.on("connection", (ws, req) => {
    ws.on("error", () => ws.terminate());
    ws.sessionId = requestSessionId(req);
    const session = activeSession(ws);
    if (!session) return;
    if (new URL(req.url, "http://localhost").searchParams.get("context") !== sessionContext(ws.sessionId)) {
      ws.close(4001, "unauthorized");
      return;
    }
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.send(JSON.stringify({ type: "hello" }));
  });
  const timer = setInterval(() => {
    for (const ws of clients) activeSession(ws);
  }, 1000);
  timer.unref();
  wss.once("close", () => clearInterval(timer));
}

/**
 * Gửi sự kiện. Nếu có userId thì chỉ gửi cho chủ sở hữu + admin, ngược lại gửi tất cả.
 */
function emit(type, data, userId = null) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const user = activeSession(ws);
    if (!user || (userId !== null && user.id !== userId && user.role !== "admin")) continue;
    ws.send(msg);
  }
}

module.exports = { attach, emit };
