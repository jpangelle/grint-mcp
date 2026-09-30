#!/usr/bin/env node
import readline from "node:readline";
import { saveCredentials } from "./credentials.js";
import { DB_PATH } from "./db.js";
import { GrintClient } from "./grint-client.js";
import { localContext } from "./local.js";

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo nothing while the password is typed.
      rl._writeToOutput = (s) => {
        if (s.startsWith(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function login() {
  const username = await ask("TheGrint username or email: ");
  const password = await ask("TheGrint password: ", { hidden: true });
  const client = new GrintClient({ username, password });
  process.stdout.write("Checking login... ");
  await client.login();
  console.log(`OK (user id ${client.userId}).`);
  saveCredentials(username, password);
  console.log("Saved: username to ~/.grint-mcp/config.json, password to the macOS Keychain (service 'grint-mcp').");
}

async function sync(fullRefresh) {
  console.log(`Syncing into ${DB_PATH}`);
  const result = await localContext().startSync({
    fullRefresh,
    budgetMs: Infinity,
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total} rounds`),
  });
  process.stdout.write("\n");
  console.log(JSON.stringify(result, null, 2));
}

const [cmd, flag] = process.argv.slice(2);
try {
  if (cmd === "login") await login();
  else if (cmd === "sync") await sync(flag === "--full");
  else {
    console.log("Usage: node src/cli.js login | sync [--full]");
    process.exit(1);
  }
} catch (e) {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
}
