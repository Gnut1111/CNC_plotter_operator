const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const express = require("express");
const test = require("node:test");

test("registration and Google callback share account roles and session rules", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pixel2plot-registration-test-"));
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  const clientFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = clientFetch;
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const clientId = "example.apps.googleusercontent.com";
  const callback = "/api/auth/google/callback";
  process.env.DATA_DIR = directory;
  process.env.DEMO_MODE = "true";
  process.env.GOOGLE_CLIENT_ID = clientId;
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_REDIRECT_URI = origin + callback;
  app.use(express.json());
  app.use("/api/auth", require("../src/auth").router);
  const { db } = require("../src/db");
  t.after(() => db.close());

  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = { ...await exportJWK(publicKey), kid: "fixture", alg: "RS256", use: "sig" };
  const codes = new Map();
  globalThis.fetch = async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [key] });
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const { body } = options;
    assert.equal(body.get("client_secret"), process.env.GOOGLE_CLIENT_SECRET);
    assert.equal(body.get("redirect_uri"), origin + callback);
    const proof = codes.get(body.get("code"));
    assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"), proof.challenge);
    codes.delete(body.get("code"));
    const token = await new SignJWT({ nonce: proof.nonce, email: proof.email, email_verified: proof.verified })
      .setProtectedHeader({ alg: "RS256", kid: key.kid }).setSubject("person-immutable-id")
      .setIssuer("https://accounts.google.com").setAudience(proof.audience)
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return Response.json({ id_token: token });
  };

  function request(path, { body, cookie, headers, method = body ? "POST" : "GET" } = {}) {
    return clientFetch(origin + "/api/auth" + path, {
      redirect: "manual", method,
      headers: { ...(cookie && { Cookie: cookie }), ...(body && { "Content-Type": "application/json" }), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  const cookie = (response, name) => response.headers.getSetCookie().find((value) => value.startsWith(name + "=")).split(";")[0];

  async function begin() {
    const response = await request("/google/start", { method: "POST" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /SameSite=Lax/);
    const url = new URL((await response.json()).url);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    return { browser: cookie(response, "pixel2plot_google"), state: url.searchParams.get("state"),
      challenge: url.searchParams.get("code_challenge"), nonce: url.searchParams.get("nonce") };
  }

  function finish(flow, existingSession) {
    return request("/google/finish", { cookie: [flow.browser, existingSession].filter(Boolean).join("; "), method: "POST" });
  }

  async function accept(flow, code, overrides = {}) {
    codes.set(code, { ...flow, email: "person@example.test", verified: true, audience: clientId, ...overrides });
    const res = await request(`/google/callback?code=${code}&state=${flow.state}`, { cookie: flow.browser });
    assert.equal(res.headers.get("location"), "/?google=finish");
  }

  assert.deepEqual(await (await request("/options")).json(), { google: true });
  const password = "fixture-local-password";
  assert.equal((await request("/register", { body: { username: "person", password: "weak" } })).status, 400);
  const local = await request("/register", { body: { username: "person", password, role: "admin" } });
  assert.equal(local.status, 201);
  const { user: localUser } = await local.json();
  const localCookie = cookie(local, "pixel2plot_session");
  assert.equal(localUser.role, "user");
  assert.equal((await request("/register", { body: { username: "PERSON", password } })).status, 409);
  assert.equal((await request("/login", { body: { username: "person", password } })).status, 409);

  const legitimate = await begin();
  const invalid = await request("/google/callback?code=invalid&state=wrong", { cookie: legitimate.browser });
  assert.equal(invalid.headers.get("location"), "/?google=expired");
  assert.equal((await finish(legitimate)).status, 400);
  await accept(legitimate, "first");
  const google = await finish(legitimate);
  assert.equal(google.status, 200);
  assert.match(google.headers.getSetCookie().find((value) => value.startsWith("pixel2plot_session=")), /SameSite=Strict/);
  const { user: googleUser } = await google.json();
  assert.equal(googleUser.role, "user");
  assert.notEqual(googleUser.id, localUser.id);
  assert.notEqual(googleUser.username, localUser.username);
  assert.equal((await finish(legitimate)).status, 400);

  const repeat = await begin();
  await accept(repeat, "second", { email: "changed-email@example.test" });
  assert.equal((await finish(repeat)).status, 409);
  const inSameBrowser = await begin();
  await accept(inSameBrowser, "third");
  assert.equal((await finish(inSameBrowser, localCookie)).status, 409);
  assert.equal((await request("/me", { cookie: localCookie })).status, 200);

  for (const [code, proof] of [
    ["bad-aud", { audience: "different-client" }],
    ["bad-nonce", { nonce: "not-this-transaction" }],
    ["unverified", { verified: false }],
  ]) {
    const flow = await begin();
    await accept(flow, code, proof);
    assert.equal((await finish(flow)).status, 401);
  }
  const denied = await begin();
  const abort = await request(`/google/callback?error=access_denied&state=${denied.state}`, { cookie: denied.browser });
  assert.equal(abort.headers.get("location"), "/?google=cancelled");
  assert.equal((await finish(denied)).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM google_accounts").get().count, 1);
});
