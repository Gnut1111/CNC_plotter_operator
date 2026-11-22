// Realtime Hub: đẩy sự kiện tới trình duyệt qua WebSocket (/ws?token=<JWT>)
const { WebSocketServer } = require("ws");
const { verifyToken } = require("./auth");

const clients = new Set();

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws, req) => {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    try {
      const payload = verifyToken(token);
      ws.user = { id: payload.sub, role: payload.role };
    } catch {
      ws.close(4001, "unauthorized");
      return;
    }
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.send(JSON.stringify({ type: "hello" }));
  });
}

/**
 * Gửi sự kiện. Nếu có userId thì chỉ gửi cho chủ sở hữu + admin, ngược lại gửi tất cả.
 */
function emit(type, data, userId = null) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (userId !== null && ws.user.id !== userId && ws.user.role !== "admin") continue;
    ws.send(msg);
  }
}

module.exports = { attach, emit };
