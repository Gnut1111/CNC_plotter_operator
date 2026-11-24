const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const mqtt = require("mqtt");
const WebSocket = require("ws");

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("single active session, revocation, access isolation and machine credentials", { timeout: 15_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel2plot-security-test-"));
  const httpPort = await freePort();
  let mqttPort = await freePort();
  while (mqttPort === httpPort) mqttPort = await freePort();
  const proc = spawn(process.execPath, [join(__dirname, "../src/index.js")], {
    env: { ...process.env, DEMO_MODE: "true", DATA_DIR: dataDir, HTTP_PORT: httpPort, MQTT_PORT: mqttPort, HTTP_HOST: "127.0.0.1",
      MQTT_HOST: "127.0.0.1", MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`, EMBEDDED_BROKER: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sockets = new Set();
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    if (proc.exitCode === null && proc.signalCode === null) {
      const exit = once(proc, "exit");
      proc.kill();
      await exit;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = "";
    proc.stdout.on("data", (buf) => {
      output += buf;
      if (output.includes("[http] ") && output.includes("server client connected")) resolve();
    });
    proc.stderr.on("data", (buf) => { output += buf; });
    proc.once("exit", (code) => reject(new Error(`Test server exited (${code}): ${output}`)));
  });

  const base = `http://127.0.0.1:${httpPort}`;
  function api(path, { session, body, headers, method = body === undefined ? "GET" : "POST" } = {}) {
    const multipart = body instanceof FormData;
    return fetch(base + "/api" + path, {
      method, headers: {
        ...(session && { Cookie: session.cookie, "X-Session-Context": session.context }),
        ...(body !== undefined && !multipart && { "Content-Type": "application/json" }),
        ...headers,
      }, body: multipart ? body : JSON.stringify(body),
    });
  }

  function login(username, password, options = {}) {
    return api("/auth/login", { body: { username, password }, ...options });
  }

  async function readLogin(response) {
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { ...(await response.json()), cookie: cookie.split(";")[0] };
  }

  function realtime(session, origin = base, headers = {}) {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?context=${session.context}`, {
      origin, headers: { Cookie: session.cookie, ...headers },
    });
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    return ws;
  }

  const parallel = await Promise.all([login("user", "user123"), login("user", "user123")]);
  assert.deepEqual(parallel.map((res) => res.status).sort(), [200, 409]);
  const first = await readLogin(parallel.find((res) => res.ok));
  const duplicate = parallel.find((res) => res.status === 409);
  assert.equal(duplicate.headers.get("set-cookie"), null);
  assert.match((await duplicate.json()).error, /thiết bị khác/);
  assert.equal((await api("/jobs", { session: first })).status, 200);
  assert.equal((await login("user", "user123", { session: first })).status, 200);
  assert.equal((await api("/admin/users", { session: first })).status, 403);
  assert.equal((await api("/jobs", { session: first, headers: { "X-Session-Context": "previous-tab" } })).status, 401);

  const foreign = realtime(first, "http://example.test");
  await assert.rejects(once(foreign, "open"), /403/);
  const online = realtime(first);
  assert.equal(JSON.parse((await once(online, "message"))[0]).type, "hello");
  assert.equal((await api("/auth/logout", { session: first, method: "POST", headers: { Origin: "http://example.test" } })).status, 403);
  assert.equal((await api("/auth/logout", { session: first, method: "POST", headers: { Origin: base } })).status, 204);
  assert.equal((await api("/auth/me", { session: first })).status, 401);
  assert.equal((await once(online, "close"))[0], 4001);

  const next = await readLogin(await login("user", "user123"));
  const adminResponse = await login("admin", "admin123", { headers: { "X-Forwarded-Proto": "https" } });
  assert.match(adminResponse.headers.get("set-cookie"), /; Secure/);
  const admin = await readLogin(adminResponse);
  const secured = realtime(admin, base.replace(/^http:/, "https:"), { "X-Forwarded-Proto": "https" });
  assert.equal(JSON.parse((await once(secured, "message"))[0]).type, "hello");
  secured.close();
  assert.equal((await api("/admin/users", { session: admin })).status, 200);
  assert.equal((await api("/admin/users/" + admin.user.id, { session: admin, method: "PATCH", body: { role: "user" } })).status, 400);
  const users = await api("/admin/users", { session: admin, body: { username: "operator2", password: "drawing-shop-fixture" } });
  assert.equal(users.status, 201);
  const other = await readLogin(await login("operator2", "drawing-shop-fixture"));

  const image = await readFile(join(__dirname, "../../docs/samples/lineart.png"));
  const upload = new FormData();
  upload.append("image", new Blob([image], { type: "image/png" }), "sample.png");
  const previewResponse = await api("/drawings/preview", { session: next, body: upload });
  assert.equal(previewResponse.status, 200);
  upload.append("previewHash", (await previewResponse.json()).previewHash);
  const saved = await api("/drawings", { session: next, body: upload });
  assert.equal(saved.status, 201);
  const { drawing } = await saved.json();
  for (const path of ["image", "gcode"]) {
    assert.equal((await api(`/drawings/${drawing.id}/${path}`, { session: next })).status, 200);
    assert.equal((await api(`/drawings/${drawing.id}/${path}`, { session: other })).status, 404);
  }
  const enqueued = await api("/jobs", { session: next, body: { drawingId: drawing.id, machineId: "cnc-01" } });
  assert.equal(enqueued.status, 201);
  const { job } = await enqueued.json();
  assert.equal((await api(`/jobs/${job.id}/cancel`, { session: other, method: "POST" })).status, 404);

  const accountPath = `/admin/users/${next.user.id}`;
  const lockedSocket = realtime(next);
  await once(lockedSocket, "message");
  assert.equal((await api(accountPath, { session: admin, method: "PATCH", body: { locked: true } })).status, 200);
  assert.equal((await once(lockedSocket, "close"))[0], 4001);
  assert.equal((await login("user", "user123")).status, 403);
  assert.equal((await api(accountPath, { session: admin, method: "PATCH", body: { locked: false } })).status, 200);
  assert.equal((await api("/auth/me", { session: next })).status, 401);
  const unlocked = await readLogin(await login("user", "user123"));
  assert.equal((await api(accountPath + "/revoke-sessions", { session: admin, method: "POST" })).status, 204);
  assert.equal((await api("/auth/me", { session: unlocked })).status, 401);
  const oldPasswordSession = await readLogin(await login("user", "user123"));
  assert.equal((await api(accountPath + "/password", { session: admin, body: { password: "replacement-fixture-password" } })).status, 204);
  assert.equal((await api("/auth/me", { session: oldPasswordSession })).status, 401);
  assert.equal((await login("user", "user123")).status, 401);
  const newPasswordSession = await readLogin(await login("user", "replacement-fixture-password"));
  assert.equal((await api(`/jobs/${job.id}`, { session: newPasswordSession })).status, 200);

  const db = new DatabaseSync(join(dataDir, "cnc.db"));
  try {
    db.prepare("UPDATE sessions SET last_seen = ? WHERE user_id = ?").run(Date.now() - 31 * 60 * 1000, next.user.id);
  } finally {
    db.close();
  }
  assert.equal((await api("/auth/me", { session: newPasswordSession })).status, 401);
  await readLogin(await login("user", "replacement-fixture-password"));

  const homePath = "/admin/machines/cnc-01/home";
  assert.equal((await api(homePath, { session: admin, method: "POST" })).status, 409);
  assert.equal((await api(homePath, { session: other, method: "POST" })).status, 403);
  const adminMachines = await api("/admin/machines", { session: admin });
  assert.ok((await adminMachines.json()).machines.every((m) => !("token" in m)));
  const tokenPath = "/admin/machines/sim-01/token";
  assert.equal((await api(tokenPath, { session: other })).status, 403);
  const token = (await (await api(tokenPath, { session: admin })).json()).token;
  const client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, {
    clientId: "sim-01", username: "sim-01", password: token, reconnectPeriod: 0,
  });
  t.after(() => client.end(true));
  await once(client, "connect");
  await client.publishAsync("cnc/sim-01/status", JSON.stringify({ state: "IDLE", jobId: null }), { qos: 1 });
  const disconnected = once(client, "close");
  assert.equal((await api(tokenPath, { session: admin, method: "POST" })).status, 204);
  await disconnected;
  const outdated = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, {
    clientId: "sim-01", username: "sim-01", password: token, reconnectPeriod: 0,
  });
  t.after(() => outdated.end(true));
  await assert.rejects(once(outdated, "connect"), { code: 4 });

  const remote = { "X-Forwarded-For": "192.0.2.43" };
  assert.equal((await login("user", "replacement-fixture-password", { headers: remote })).status, 403);
  const address = { "X-Forwarded-For": "::1" };
  for (let i = 0; i < 20; i++) assert.equal((await login("user", "wrong", { headers: address })).status, 401);
  const throttled = await login("user", "wrong", { headers: address });
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("retry-after")) > 0);
});
