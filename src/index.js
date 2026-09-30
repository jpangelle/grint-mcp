#!/usr/bin/env node
// Local mode: Claude Desktop launches this and talks to it over stdio.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localContext } from "./local.js";
import { createServer } from "./server.js";

await createServer(localContext()).connect(new StdioServerTransport());
