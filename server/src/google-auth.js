const { createHash, randomBytes } = require("node:crypto");
const { findOrCreateGoogleUser } = require("./accounts");
const config = require("./config");
const sessions = require("./sessions");

const google = config.google;
const cookieName = "pixel2plot_google";
const flowMs = 10 * 60 * 1000;
const transactions = new Map();
let keys;
const random = () => randomBytes(32).toString("base64url");

function available(req) {
  return google && `${req.protocol}://${req.headers.host}` === google.redirect.origin;
}

function getTransaction(req) {
  if (!available(req)) return {};
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((part) => part.startsWith(cookieName + "="));
  const handle = cookie?.slice(cookieName.length + 1);
  const flow = transactions.get(handle);
  if (!flow || flow.expires <= Date.now()) {
    transactions.delete(handle);
    return {};
  }
  return { handle, flow };
}

function cookieOptions(req) {
  return { httpOnly: true, secure: req.secure, sameSite: "lax", path: "/api/auth/google" };
}

function mountGoogle(router, throttle, finishSession) {
  router.post("/google/start", throttle, (req, res) => {
    if (!available(req)) return res.status(503).json({ error: "Đăng nhập Google chưa được cấu hình cho địa chỉ này." });
    if (sessions.getSession(sessions.requestSessionId(req))) {
      return res.status(409).json({ error: "Hãy đăng xuất tài khoản đang dùng trên trình duyệt trước." });
    }
    const now = Date.now();
    for (const [handle, flow] of transactions) {
      if (flow.expires <= now) transactions.delete(handle);
    }
    const previous = getTransaction(req);
    if (previous.handle) transactions.delete(previous.handle);
    if (transactions.size >= 1000) return res.status(503).json({ error: "Đăng nhập Google đang bận, vui lòng thử lại." });

    const handle = random();
    const flow = { state: random(), verifier: random(), nonce: random(), expires: now + flowMs, code: null };
    transactions.set(handle, flow);
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.search = new URLSearchParams({
      response_type: "code",
      client_id: google.clientId,
      redirect_uri: google.redirect.href,
      scope: "openid email",
      prompt: "select_account",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    res.cookie(cookieName, handle, { ...cookieOptions(req), maxAge: flowMs });
    res.json({ url: target.href });
  });

  router.get("/google/callback", (req, res) => {
    const { handle, flow } = getTransaction(req);
    if (!flow || flow.code || req.query.state !== flow.state) return res.redirect(303, "/?google=expired");
    if (req.query.error || typeof req.query.code !== "string" || !req.query.code || req.query.code.length > 2048) {
      transactions.delete(handle);
      res.clearCookie(cookieName, cookieOptions(req));
      return res.redirect(303, req.query.error === "access_denied" ? "/?google=cancelled" : "/?google=failed");
    }
    flow.code = req.query.code;
    // Finish through a same-origin request so the original Strict session cookie is available.
    res.redirect(303, "/?google=finish");
  });

  router.post("/google/finish", async (req, res, next) => {
    const { handle, flow } = getTransaction(req);
    if (!flow?.code) return res.status(400).json({ error: "Lượt đăng nhập Google đã hết hạn. Vui lòng thử lại." });
    transactions.delete(handle);
    res.clearCookie(cookieName, cookieOptions(req));

    let identity;
    try {
      identity = await exchange(flow);
    } catch {
      return res.status(401).json({ error: "Chưa xác thực được tài khoản Google. Vui lòng thử lại." });
    }
    if (res.destroyed) return;
    try {
      if (sessions.getSession(sessions.requestSessionId(req))) {
        return res.status(409).json({ error: "Hãy đăng xuất tài khoản đang dùng trên trình duyệt trước." });
      }
      finishSession(req, res, findOrCreateGoogleUser(identity.sub, identity.email));
    } catch (err) {
      next(err);
    }
  });
}

async function exchange(flow) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: google.clientId,
      client_secret: google.clientSecret,
      redirect_uri: google.redirect.href,
      code: flow.code,
      code_verifier: flow.verifier,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Google token request failed");
  const { id_token: idToken } = await response.json();
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  keys ??= createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 8000 });
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: google.clientId,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    maxTokenAge: "10m",
  });
  const needsAuthorizedParty = Array.isArray(payload.aud) && payload.aud.length > 1;
  if (payload.nonce !== flow.nonce || ((needsAuthorizedParty || payload.azp !== undefined) && payload.azp !== google.clientId)
      || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255
      || payload.email_verified !== true || typeof payload.email !== "string" || !payload.email.includes("@")) {
    throw new Error("Unexpected Google identity claims");
  }
  return payload;
}

module.exports = { available, mountGoogle };
