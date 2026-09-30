# grint-mcp

An unofficial MCP server for [TheGrint](https://thegrint.com). It syncs your rounds and hole-by-hole scorecards into a local SQLite database, so Claude can answer questions TheGrint's UI can't, like:

- "How many times have I parred hole 3 at Jimmy Clay?"
- "What's my scoring average on par 5s this year vs last year?"
- "Which hole at Roy Kizer do I play worst relative to par?"
- "How often do I 3-putt after hitting the green?"
- "Show my best 9-hole score at each course."

TheGrint has no public API. This logs in the same way the website does and reads the same pages, so it can break if TheGrint changes their site. It only reads data and never changes anything on your account.

## Setup

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
npm run login      # prompts for your TheGrint username + password, verifies them, stores the password in the macOS Keychain
npm run sync       # first full import (a few minutes for a couple hundred rounds)
npm test           # optional: parser/DB tests, stdio smoke test, hosted OAuth end-to-end test
```

Then quit Claude Desktop completely (Cmd+Q), run `npm run install-claude`, and reopen it. Quit first: Claude Desktop rewrites its config file from memory and can drop an entry added while it's running.

The script adds this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "grint": {
      "command": "/absolute/path/to/node",
      "args": ["--no-warnings", "/absolute/path/to/grint-mcp/src/index.js"]
    }
  }
}
```

Use the absolute path from `which node`. Claude Desktop doesn't load your shell profile, so a bare `node` often isn't found when installed via nvm. If you switch Node versions with nvm, update this path.

Instead of the Keychain you can pass `GRINT_USERNAME` and `GRINT_PASSWORD` in an `"env"` block, but then your password sits in plain text in that config file.

## Hosted mode (anyone can connect, including Claude mobile)

`src/http.js` is a multi-user server. Anyone adds `https://<your-app>.fly.dev/mcp` as a custom connector in Claude (Settings → Connectors → Add custom connector, OAuth fields left empty). Claude then opens a sign-in page where they log in with their own TheGrint account. The connector then works in Claude on web, desktop and mobile.

How it works:
- Claude runs a standard OAuth 2.1 flow (dynamic client registration + PKCE) against this server, using the MCP SDK's auth router.
- The sign-in form checks the username/password against TheGrint once. **Passwords are never stored.** Only TheGrint's 90-day "remember me" cookie is kept, encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`).
- Access tokens (stored as SHA-256 hashes) expire with that session, after which Claude asks the user to sign in again.
- Each user gets their own SQLite file. The query connection uses a SQLite authorizer that only allows reads, so SQL can't `ATTACH` another user's file or write anything.
- Only Claude's callback hosts (`claude.ai`, `claude.com`) can register as OAuth clients (`ALLOWED_REDIRECT_HOSTS`), and sign-in attempts are rate-limited per IP.

Deploy to Fly.io:

```bash
fly auth login
fly apps create grint-mcp-jpangelle            # app names are global; if taken, pick another and update app + PUBLIC_URL in fly.toml
fly volumes create grint_data --region dfw --size 1 -y
fly secrets set TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32) --stage
fly deploy
```

Open `https://grint-mcp-jpangelle.fly.dev` for the connector URL and instructions to share. If `TOKEN_ENCRYPTION_KEY` is ever lost or changed, everyone just signs in again.

Each user's first sign-in imports their rounds in the background (a couple of minutes for ~200 rounds). Logs: `fly logs`.

## Tools

| Tool | What it does |
| --- | --- |
| `grint_overview` | Round count, date range, last sync, and every course with exact names/tees. Helps Claude map "jimmy clay" to the stored course name. |
| `query_grint_data` | Runs a read-only SQL query against the cache. The full schema is in the tool description, so Claude writes the SQL itself. |
| `sync_grint_data` | Pulls new/changed rounds (or `full_refresh`). Runs ~45s per call and reports `remaining` if there's more. |

Queries sync on their own when the data is more than 6 hours old (`GRINT_AUTO_SYNC_HOURS` to change, `0` to disable).

## Data model

- `rounds`: one row per round (date, course, tee, rating/slope, score, par, putts, handicap differential, tournament/practice flags, `round_type` = `18`/`F9`/`B9`).
- `holes`: one row per hole played (par, yardage, stroke index, strokes, `result` such as `birdie`/`par`/`bogey`, putts, GIR, fairway direction, penalties).
- `hole_details`: a view joining `holes` with round info. Most questions are one query against this view.

Notes:
- GIR is computed as `strokes - putts <= par - 2`, only for rounds where putts were tracked (otherwise `NULL`).
- Fairway codes come from TheGrint's tee-accuracy field: `hit`, `left`, `right`, `short`, `long`, `far_left`, `far_right`.
- Penalty codes from TheGrint: `s` greenside sand, `f` fairway sand, `w` water, `o` out of bounds, `d` drop/unplayable.

## Files

- Database: `~/.grint-mcp/grint.db` (override with `GRINT_DB_PATH`). Delete it to start fresh.
- Username: `~/.grint-mcp/config.json`. Password: macOS Keychain item `grint-mcp`.
