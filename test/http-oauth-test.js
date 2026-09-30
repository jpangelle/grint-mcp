// End-to-end test of hosted mode: the full OAuth flow Claude runs, against a
// fake TheGrint with two users. Checks sign-in, PKCE, per-user isolation, and
// that no passwords or TheGrint sessions are stored in plaintext.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ---------- fake TheGrint
const USERS = {
  alice: { password: "alice-pw-123", id: "111", remember: "remember-alice-secret", round: "9001", course: "Alice Links" },
  bob: { password: "bob-pw-456", id: "222", remember: "remember-bob-secret", round: "9002", course: "Bob Muni" },
};
const byRemember = (cookie = "") => Object.values(USERS).find((u) => cookie.includes(`remember=${u.remember}`));
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => r(b)); });

const scoreRow = (u) => `<tr><td> 09/01/26 </td><td> ${u.course} <p> Blue 70.00 | 120 </p></td><td><div> 80 </div></td><td> 18 </td><td> 30 </td><td> 50% </td><td></td><td> 9.0 </td><td></td><td><img src="x"></td><td></td><td><a href="https://thegrint.com/score/edit_score/${u.round}?handicap_company_id=3">View</a></td></tr>`;
const card = () => {
  let inputs = `<input type="hidden" id="round" value="18"><input type="hidden" name="course" value="1"><input type="hidden" class="tees-db" value="Blue">`;
  for (let h = 1; h <= 18; h++) inputs += `<input name="scH${h}" value="4"><input name="ptH${h}" value="2"><input name="pH${h}" value=""><input name="fH${h}" value="3">`;
  return `<form>${inputs}<select name="year"><option value="2026" selected>2026</option></select><select name="month"><option value="09" selected>09</option></select><select name="date"><option value="01" selected>01</option></select></form>`;
};
const tds = (arr) => arr.map((v, i) => `<td class="data-entry ${i + 1}">${v}</td>`).join("");
const courseData = JSON.stringify({ par: tds(Array(18).fill(4)), handicap: tds([...Array(18).keys()].map((i) => i + 1)), yardage: tds(Array(18).fill(400)) });

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const user = byRemember(req.headers.cookie);
  if (url.pathname === "/login" && req.method === "POST") {
    const f = new URLSearchParams(await readBody(req));
    const u = USERS[f.get("username")];
    if (u && u.password === f.get("password")) {
      res.writeHead(302, { Location: "/dashboard", "Set-Cookie": [`remember=${u.remember}; expires=Thu, 24-Dec-2026 18:51:00 GMT; Max-Age=7776000; path=/`, "PHPSESSID=abc; path=/"] });
    } else res.writeHead(302, { Location: "/passthru" });
    return res.end();
  }
  if (["/login", "/passthru", "/dashboard"].includes(url.pathname)) return res.end("page");
  if (!user) return res.writeHead(302, { Location: "/passthru" }).end();
  if (url.pathname === "/score") return res.end(`<input id="filterUserIdScore" value="${user.id}"><table class="tableListScore"><tbody>${scoreRow(user)}</tbody></table>`);
  if (url.pathname === "/score/listMoreScores") return res.end("");
  if (url.pathname.startsWith("/score/edit_score/")) return res.end(card());
  if (url.pathname.startsWith("/ajax/get_course_data")) return res.end(courseData);
  res.writeHead(404).end();
});
await new Promise((r) => fake.listen(0, r));
const GRINT = `http://localhost:${fake.address().port}`;

// ---------- server under test
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grint-oauth-"));
const PORT = 19_000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../src/http.js", import.meta.url))], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_URL: BASE,
    DATA_DIR: tmp,
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
    GRINT_BASE_URL: GRINT,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => child.stdout.once("data", resolve));

let CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const ok = (msg) => console.log(`ok  ${msg}`);

async function signIn(username, password) {
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }),
  });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const auth = await fetch(
    `${BASE}/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "st8" })}`
  );
  assert.equal(auth.status, 200);
  assert.match(await auth.text(), /Connect TheGrint/);

  const form = { client_id, redirect_uri: CALLBACK, state: "st8", code_challenge: challenge, username, password };
  const login = await fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams(form), redirect: "manual" });
  if (login.status !== 302) return { status: login.status, body: await login.text() };
  const loc = new URL(login.headers.get("location"));
  assert.equal(`${loc.origin}${loc.pathname}`, CALLBACK);
  assert.equal(loc.searchParams.get("state"), "st8");
  const code = loc.searchParams.get("code");

  const tokenReq = () =>
    fetch(`${BASE}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: CALLBACK }),
    });
  const tok = await tokenReq();
  assert.equal(tok.status, 200);
  const { access_token, expires_in } = await tok.json();
  assert.ok(expires_in > 80 * 24 * 3600, "token lives about as long as the 90-day TheGrint session");
  assert.equal((await tokenReq()).status, 400, "auth code is single-use");
  return { status: 302, token: access_token };
}

async function mcp(token) {
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  );
  const query = async (sql) => {
    const r = await client.callTool({ name: "query_grint_data", arguments: { sql } });
    return { error: r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
  };
  return { client, query };
}

try {
  // Discovery: unauthenticated MCP calls point Claude at the OAuth metadata.
  const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate"), /resource_metadata=.*oauth-protected-resource\/mcp/);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  ok("401 + protected resource metadata for discovery");

  const evil = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(evil.status, 400);
  ok("clients with non-Claude redirect URIs are rejected");

  const register = (redirect) =>
    fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "t", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    }).then((r) => r.status);
  for (const uri of ["http://localhost:33418/callback", "http://127.0.0.1:5000/cb", "http://[::1]:8000/cb", "https://chatgpt.com/connector_platform_oauth_redirect"]) {
    assert.equal(await register(uri), 201, `${uri} should be allowed`);
  }
  for (const uri of ["javascript://localhost/%0aalert(1)", "http://evil.example/cb", "http://claude.ai/api/mcp/auth_callback", "https://localhost.evil.example/cb"]) {
    assert.equal(await register(uri), 400, `${uri} should be rejected`);
  }
  ok("desktop (localhost) and ChatGPT callbacks allowed; lookalikes and non-https hosts rejected");

  const bad = await signIn("alice", "wrong-password");
  assert.equal(bad.status, 401);
  assert.match(bad.body, /didn&#39;t accept|didn't accept/);
  ok("wrong TheGrint password re-shows the form with an error");

  const alice = await signIn("alice", USERS.alice.password);
  CALLBACK = "http://localhost:33418/callback"; // Bob signs in the way Claude Code does
  const bob = await signIn("bob", USERS.bob.password);
  ok("full OAuth flow for two users (one via claude.ai, one via a Claude Code localhost callback)");

  const a = await mcp(alice.token);
  const ra = await a.query("SELECT course_name, COUNT(*) AS n FROM hole_details GROUP BY course_name");
  assert.deepEqual(ra.data.rows, [{ course_name: "Alice Links", n: 18 }]);
  const b = await mcp(bob.token);
  const rb = await b.query("SELECT course_name, COUNT(*) AS n FROM hole_details GROUP BY course_name");
  assert.deepEqual(rb.data.rows, [{ course_name: "Bob Muni", n: 18 }]);
  ok("each user syncs and sees only their own rounds");

  const attach = await b.query(`SELECT * FROM pragma_database_list`);
  assert.ok(attach.error, "pragma functions are denied");
  const attach2 = await b.query(`ATTACH DATABASE '${path.join(tmp, "users", "111.db")}' AS a`);
  assert.ok(attach2.error, "ATTACH is denied");
  const write = await b.query("DELETE FROM rounds");
  assert.ok(write.error, "writes are denied");
  ok("SQL can't attach other users' databases or write");

  const bogus = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(bogus.status, 401);
  ok("invalid bearer token -> 401");

  await a.client.close();
  await b.client.close();

  const authDb = fs.readFileSync(path.join(tmp, "auth.db")).toString("latin1") + (fs.existsSync(path.join(tmp, "auth.db-wal")) ? fs.readFileSync(path.join(tmp, "auth.db-wal")).toString("latin1") : "");
  for (const secret of [USERS.alice.password, USERS.alice.remember, USERS.bob.password, USERS.bob.remember, alice.token, bob.token]) {
    assert.ok(!authDb.includes(secret), `secret stored in plaintext: ${secret.slice(0, 8)}...`);
  }
  ok("no passwords, TheGrint sessions or access tokens stored in plaintext");

  console.log("Hosted OAuth test passed.");
} finally {
  child.kill();
  fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
