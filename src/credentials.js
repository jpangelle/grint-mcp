import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Credentials resolve from env vars first, then from the macOS Keychain
// (written by `npm run login`). The username lives in a small config file;
// the password only ever lives in the Keychain.
const KEYCHAIN_SERVICE = "grint-mcp";
export const CONFIG_DIR = path.join(os.homedir(), ".grint-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function getCredentials() {
  if (process.env.GRINT_USERNAME && process.env.GRINT_PASSWORD) {
    return { username: process.env.GRINT_USERNAME, password: process.env.GRINT_PASSWORD };
  }
  const { username } = readConfig();
  if (!username) return null;
  try {
    const password = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", username, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return password ? { username, password } : null;
  } catch {
    return null;
  }
}

export function saveCredentials(username, password) {
  // -U updates the item if it already exists.
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", username, "-w", password],
    { stdio: "ignore" }
  );
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ username }, null, 2), { mode: 0o600 });
}
