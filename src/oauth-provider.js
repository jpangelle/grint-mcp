// OAuth 2.1 authorization server for the hosted connector. The MCP SDK's
// mcpAuthRouter handles the protocol (metadata, dynamic client registration,
// PKCE checks, token endpoint); this provider supplies storage and swaps the
// usual "consent screen" for a TheGrint sign-in form.
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { AuthError, GrintClient } from "./grint-client.js";
import { PAGE_HEADERS, loginPage } from "./login-page.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_TOKEN_SECONDS = 90 * 24 * 3600;
const DEFAULT_TOKEN_SECONDS = 30 * 24 * 3600;

export class GrintOAuthProvider {
  constructor({ store, allowedRedirectHosts, allowLocalhostRedirects = true, onUserSignedIn }) {
    this.store = store;
    this.allowedRedirectHosts = allowedRedirectHosts;
    this.allowLocalhostRedirects = allowLocalhostRedirects;
    this.onUserSignedIn = onUserSignedIn;
  }

  // Codes may only go to known hosted clients (Claude, ChatGPT) or to a
  // loopback address, so another website can't register a client and use this
  // server's sign-in page to collect tokens. Loopback is how desktop clients
  // like Claude Code receive the callback (RFC 8252 section 7.3); a code sent
  // there stays on the user's own machine.
  isAllowedRedirect(uri) {
    let u;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (this.allowLocalhostRedirects && LOOPBACK_HOSTS.has(u.hostname)) {
      return u.protocol === "http:" || u.protocol === "https:";
    }
    return u.protocol === "https:" && this.allowedRedirectHosts.includes(u.hostname);
  }

  get clientsStore() {
    return {
      getClient: (clientId) => this.store.getClient(clientId),
      registerClient: (client) => {
        const bad = (client.redirect_uris ?? []).filter((u) => !this.isAllowedRedirect(String(u)));
        if (!client.redirect_uris?.length || bad.length) {
          throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad.join(", ") || "(none)"}`);
        }
        return this.store.saveClient(client);
      },
    };
  }

  // GET/POST /authorize (validated by the SDK) -> show the sign-in form.
  async authorize(client, params, res) {
    res.set(PAGE_HEADERS).send(
      loginPage({
        clientName: client.client_name,
        fields: {
          client_id: client.client_id,
          redirect_uri: params.redirectUri,
          state: params.state,
          code_challenge: params.codeChallenge,
          scope: params.scopes?.join(" "),
        },
      })
    );
  }

  // POST /login -> check the TheGrint login, keep the session, redirect back to Claude with a code.
  async handleLogin(req, res) {
    const { client_id, redirect_uri, state, code_challenge, scope, username, password } = req.body ?? {};
    const client = client_id ? this.store.getClient(client_id) : undefined;
    if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri) || !code_challenge) {
      res.status(400).type("text/plain").send("Invalid sign-in request. Start again from Claude.");
      return;
    }
    const fields = { client_id, redirect_uri, state, code_challenge, scope };
    const again = (status, error) =>
      res.status(status).set(PAGE_HEADERS).send(loginPage({ clientName: client.client_name, fields, error, username }));

    if (!username || !password) return again(400, "Enter your TheGrint username and password.");

    const grint = new GrintClient({ username, password, remember: true });
    try {
      await grint.login();
    } catch (e) {
      if (e instanceof AuthError) return again(401, "TheGrint didn't accept that username and password.");
      console.error("TheGrint login error:", e.message);
      return again(502, "Couldn't reach TheGrint. Try again in a minute.");
    }
    if (!grint.rememberToken) return again(502, "TheGrint signed you in but didn't return a session. Try again.");

    this.store.upsertUser({
      userId: grint.userId,
      username,
      rememberToken: grint.rememberToken,
      rememberExpiresAt: grint.rememberExpiresAt,
    });
    this.onUserSignedIn?.(grint.userId);

    const code = this.store.createCode({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      userId: grint.userId,
      scopes: scope,
    });
    const target = new URL(redirect_uri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(client, code) {
    const row = this.store.getCode(code);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri) {
    const row = this.store.getCode(code);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    this.store.deleteCode(code); // single use
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");

    // The token lives as long as the TheGrint session behind it, so when that
    // expires Claude gets a 401 and asks the user to sign in again.
    const user = this.store.getUser(row.user_id);
    const nowS = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(user?.rememberExpiresAt ?? nowS + DEFAULT_TOKEN_SECONDS, nowS + MAX_TOKEN_SECONDS);
    const accessToken = this.store.createToken({ clientId: client.client_id, userId: row.user_id, expiresAt });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresAt - nowS,
      ...(row.scopes ? { scope: row.scopes } : {}),
    };
  }

  async exchangeRefreshToken() {
    throw new UnsupportedGrantTypeError("Refresh tokens are not supported; sign in again.");
  }

  async verifyAccessToken(token) {
    const row = this.store.getToken(token);
    if (!row) throw new InvalidTokenError("Invalid or expired token");
    return { token, clientId: row.client_id, scopes: [], expiresAt: row.expires_at, extra: { userId: row.user_id } };
  }

  async revokeToken(_client, { token }) {
    this.store.deleteToken(token);
  }
}
