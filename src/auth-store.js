// Storage for the hosted (multi-user) server: OAuth clients, auth codes,
// access tokens, and each user's TheGrint session.
//
// Users' TheGrint passwords are never stored. At sign-in the password is used
// once to log in; only TheGrint's 90-day "remember me" cookie is kept, and it
// is encrypted with TOKEN_ENCRYPTION_KEY. Codes and access tokens are stored
// as SHA-256 hashes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const CODE_TTL_SECONDS = 10 * 60;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => Math.floor(Date.now() / 1000);

export class AuthStore {
  constructor(dbPath, encryptionKeyHex) {
    this.key = Buffer.from(encryptionKeyHex ?? "", "hex");
    if (this.key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY, username TEXT, remember_enc TEXT NOT NULL,
        remember_expires_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `);
  }

  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  decrypt(encoded) {
    const buf = Buffer.from(encoded, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  }

  // --- OAuth clients (dynamic client registration)
  getClient(clientId) {
    const row = this.db.prepare("SELECT data FROM clients WHERE client_id = ?").get(clientId);
    return row ? JSON.parse(row.data) : undefined;
  }

  saveClient(client) {
    this.db
      .prepare("INSERT OR REPLACE INTO clients (client_id, data, created_at) VALUES (?, ?, ?)")
      .run(client.client_id, JSON.stringify(client), now());
    return client;
  }

  // --- users
  upsertUser({ userId, username, rememberToken, rememberExpiresAt }) {
    if (!/^\d+$/.test(String(userId))) throw new Error(`Unexpected TheGrint user id: ${userId}`);
    this.db
      .prepare(
        `INSERT INTO users (user_id, username, remember_enc, remember_expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, remember_enc = excluded.remember_enc,
           remember_expires_at = excluded.remember_expires_at, updated_at = excluded.updated_at`
      )
      .run(String(userId), username, this.encrypt(rememberToken), rememberExpiresAt ?? null, now());
  }

  getUser(userId) {
    const row = this.db.prepare("SELECT * FROM users WHERE user_id = ?").get(String(userId));
    if (!row) return null;
    return {
      userId: row.user_id,
      username: row.username,
      rememberToken: this.decrypt(row.remember_enc),
      rememberExpiresAt: row.remember_expires_at,
    };
  }

  // --- authorization codes (single use, 10 minutes)
  createCode({ clientId, redirectUri, codeChallenge, userId, scopes }) {
    const code = crypto.randomBytes(32).toString("base64url");
    this.db
      .prepare(
        `INSERT INTO auth_codes (code_hash, client_id, redirect_uri, code_challenge, user_id, scopes, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sha256(code), clientId, redirectUri, codeChallenge, String(userId), scopes ?? "", now() + CODE_TTL_SECONDS);
    return code;
  }

  getCode(code) {
    return this.db
      .prepare("SELECT * FROM auth_codes WHERE code_hash = ? AND expires_at > ?")
      .get(sha256(code), now());
  }

  deleteCode(code) {
    this.db.prepare("DELETE FROM auth_codes WHERE code_hash = ?").run(sha256(code));
  }

  // --- access tokens
  createToken({ clientId, userId, expiresAt }) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO tokens (token_hash, client_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), clientId, String(userId), expiresAt, now());
    return token;
  }

  getToken(token) {
    return this.db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND expires_at > ?").get(sha256(token), now());
  }

  deleteToken(token) {
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(sha256(token));
  }

  purgeExpired() {
    const t = now();
    this.db.prepare("DELETE FROM auth_codes WHERE expires_at <= ?").run(t);
    this.db.prepare("DELETE FROM tokens WHERE expires_at <= ?").run(t);
  }
}
