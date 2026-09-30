#!/usr/bin/env node
// Registers this server in Claude Desktop's config. Run it while Claude Desktop
// is quit: the app rewrites the config file from memory and can drop edits
// made while it's running.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cfgPath = path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
const server = fileURLToPath(new URL("./index.js", import.meta.url));

const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
cfg.mcpServers ??= {};
cfg.mcpServers.grint = { command: process.execPath, args: ["--no-warnings", server] };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

console.log(`Added "grint" to ${cfgPath}:`);
console.log(JSON.stringify(cfg.mcpServers.grint, null, 2));
console.log("Now open Claude Desktop.");
