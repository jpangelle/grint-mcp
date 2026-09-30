#!/usr/bin/env node
// Hosted mode: a multi-user MCP server over Streamable HTTP. Anyone can add
// https://<host>/mcp as a custom connector in Claude (web, desktop, mobile);
// Claude runs an OAuth flow that asks them to sign in with their TheGrint account.
//
// Env:
//   PUBLIC_URL             https://your-app.fly.dev (required)
//   TOKEN_ENCRYPTION_KEY   64 hex chars, encrypts stored TheGrint sessions (required)
//   DATA_DIR               where auth.db and per-user caches live (default /data)
//   ALLOWED_REDIRECT_HOSTS hosted OAuth callback hosts (default claude.ai,claude.com,chatgpt.com)
//   ALLOW_LOCALHOST_REDIRECTS set to 0 to refuse loopback callbacks used by desktop clients
import path from "node:path";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { AuthStore } from "./auth-store.js";
import { Cache } from "./db.js";
import { AuthError, GrintClient } from "./grint-client.js";
import { PAGE_HEADERS, landingPage } from "./login-page.js";
import { GrintOAuthProvider } from "./oauth-provider.js";
import { GolferContext, createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
if (!process.env.PUBLIC_URL) {
  console.error("PUBLIC_URL must be set (e.g. https://your-app.fly.dev).");
  process.exit(1);
}
const PUBLIC_URL = new URL(process.env.PUBLIC_URL);
const MCP_URL = new URL("/mcp", PUBLIC_URL);

const store = new AuthStore(path.join(DATA_DIR, "auth.db"), process.env.TOKEN_ENCRYPTION_KEY);
store.purgeExpired();
setInterval(() => store.purgeExpired(), 3600_000).unref();

// One context (cache file + TheGrint client) per signed-in user.
const contexts = new Map();
function contextFor(userId) {
  let ctx = contexts.get(userId);
  if (!ctx) {
    ctx = new GolferContext({
      cache: new Cache(path.join(DATA_DIR, "users", `${userId}.db`)),
      createClient: () => {
        const user = store.getUser(userId);
        if (!user) throw new AuthError("Unknown user. Reconnect the Grint connector in Claude.");
        return new GrintClient({ rememberToken: user.rememberToken });
      },
    });
    contexts.set(userId, ctx);
  }
  return ctx;
}

const provider = new GrintOAuthProvider({
  store,
  allowedRedirectHosts: (process.env.ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com,chatgpt.com")
    .split(",")
    .map((h) => h.trim()),
  // Desktop clients (Claude Code, Claude Desktop, Cursor...) receive the callback on localhost.
  allowLocalhostRedirects: process.env.ALLOW_LOCALHOST_REDIRECTS !== "0",
  // After sign-in, use the fresh session and start importing their rounds right away.
  onUserSignedIn: (userId) => {
    const ctx = contextFor(userId);
    ctx.client = null;
    ctx.startSync({ budgetMs: Infinity }).catch((e) => console.error(`Initial sync for ${userId} failed: ${e.message}`));
  },
});

const app = express();
app.set("trust proxy", 1); // behind Fly's proxy; needed for per-IP rate limits
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));
app.get("/", (_req, res) => res.set(PAGE_HEADERS).send(landingPage(MCP_URL.href)));

// OAuth: /.well-known/*, /authorize, /token, /register, /revoke
app.use(mcpAuthRouter({ provider, issuerUrl: PUBLIC_URL, resourceServerUrl: MCP_URL, resourceName: "TheGrint (unofficial)" }));

// The sign-in form posts here. Rate-limited to slow down password guessing.
app.post(
  "/login",
  rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false }),
  express.urlencoded({ extended: false, limit: "10kb" }),
  (req, res) =>
    provider.handleLogin(req, res).catch((e) => {
      console.error("Login handler failed:", e);
      if (!res.headersSent) res.status(500).type("text/plain").send("Something went wrong. Try again.");
    })
);

// MCP itself. Stateless: each request gets a fresh server + transport, so Fly
// can stop and restart the machine without losing sessions.
const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_URL) });
app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
  const server = createServer(contextFor(req.auth.extra.userId));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP request failed:", e);
    if (!res.headersSent) res.status(500).end();
  }
});
app.all("/mcp", (_req, res) => res.set("Allow", "POST").status(405).end());

app.listen(PORT, () => console.log(`grint MCP listening on :${PORT} (${MCP_URL.href})`));
