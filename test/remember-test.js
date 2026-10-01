// TheGrint keeps one "remember me" token per account: a password login with
// remember=on issues a new token and kills the previous one. The hosted server
// stores that token, so local mode (Claude Desktop, CLI) must log in WITHOUT
// remember=on, or every Desktop start logs the hosted connector out.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

const PASSWORD = "pw";
let currentRemember = null; // the one valid remember token
const sessions = new Set(); // valid PHPSESSIDs

const cookie = (req, name) => req.headers.cookie?.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1];
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => r(b)); });

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/login" && req.method === "POST") {
    const f = new URLSearchParams(await readBody(req));
    if (f.get("password") !== PASSWORD) return res.writeHead(302, { Location: "/passthru" }).end();
    const sid = crypto.randomUUID();
    sessions.add(sid);
    const headers = ["PHPSESSID=" + sid + "; path=/"];
    if (f.get("remember") === "on") {
      currentRemember = crypto.randomUUID(); // rotates: the previous token stops working
      headers.push(`remember=${currentRemember}; Max-Age=7776000; path=/`);
    }
    return res.writeHead(302, { Location: "/dashboard", "Set-Cookie": headers }).end();
  }
  if (["/login", "/passthru", "/dashboard"].includes(url.pathname)) return res.end("page");
  const sid = cookie(req, "PHPSESSID");
  const rem = cookie(req, "remember");
  let ok = sid && sessions.has(sid);
  if (!ok && rem && rem === currentRemember) {
    const newSid = crypto.randomUUID();
    sessions.add(newSid);
    res.setHeader("Set-Cookie", `PHPSESSID=${newSid}; path=/`);
    ok = true;
  }
  if (!ok) return res.writeHead(302, { Location: "/passthru" }).end();
  res.end(`<input id="filterUserIdScore" value="1000001"><table class="tableListScore"><tbody></tbody></table>`);
});
await new Promise((r) => fake.listen(0, r));
process.env.GRINT_BASE_URL = `http://localhost:${fake.address().port}`;
const { GrintClient } = await import("../src/grint-client.js");

try {
  // Hosted sign-in: asks for a remember token and stores it.
  const hosted = new GrintClient({ username: "me", password: PASSWORD, remember: true });
  await hosted.login();
  assert.ok(hosted.rememberToken, "hosted sign-in gets a remember token");
  const stored = hosted.rememberToken;

  // Later, Claude Desktop starts and logs in with the password (local mode defaults).
  const local = new GrintClient({ username: "me", password: PASSWORD });
  await local.login();
  assert.equal(local.userId, "1000001", "local password login works");

  // The hosted server's stored token must still restore a session.
  const restored = new GrintClient({ rememberToken: stored });
  await restored.login();
  assert.equal(restored.userId, "1000001", "hosted token still works after a local login");

  console.log("Remember-token test passed.");
} finally {
  fake.close();
}
