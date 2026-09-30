// Starts the MCP server over stdio (as Claude Desktop does) and exercises its tools.
// Uses an empty temp DB and no network sync.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grint-smoke-"));
const server = fileURLToPath(new URL("../src/index.js", import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--no-warnings", server],
  env: { ...process.env, GRINT_DB_PATH: path.join(tmp, "smoke.db"), GRINT_AUTO_SYNC_HOURS: "0" },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const instructions = client.getInstructions() ?? "";
console.log("instructions sent:", instructions ? `${instructions.split("\n")[0].slice(0, 70)}...` : "NONE");

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`${name}${args.sql ? ` [${args.sql}]` : ""} ->`, r.isError ? "ERROR" : "ok", r.content[0].text.slice(0, 160).replace(/\s+/g, " "));
  return r;
};
const ok = await call("query_grint_data", { sql: "SELECT COUNT(*) AS n FROM hole_details" });
const bad = await call("query_grint_data", { sql: "DROP TABLE rounds" });
await call("grint_overview");

await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
const describesViews = tools.find((t) => t.name === "query_grint_data")?.description.includes("CREATE VIEW hole_details");
console.log("query tool shows hole_details view:", describesViews);
if (ok.isError || !bad.isError || tools.length !== 3 || !instructions.includes("golf") || !describesViews) {
  console.error("Smoke test FAILED");
  process.exit(1);
}
console.log("Smoke test passed.");
