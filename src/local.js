// Single-user context for local mode (Claude Desktop over stdio, and the CLI).
import { getCredentials } from "./credentials.js";
import { Cache } from "./db.js";
import { AuthError, GrintClient } from "./grint-client.js";
import { GolferContext } from "./server.js";

export function localContext() {
  return new GolferContext({
    cache: new Cache(),
    createClient: () => {
      const creds = getCredentials();
      if (!creds) {
        throw new AuthError(
          "No TheGrint credentials found. Run `npm run login` in the grint-mcp folder, or set GRINT_USERNAME and GRINT_PASSWORD."
        );
      }
      return new GrintClient(creds);
    },
  });
}
