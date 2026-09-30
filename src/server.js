import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SCHEMA_SQL, VIEWS_SQL } from "./db.js";
import { syncRounds } from "./sync.js";

const MAX_ROWS = 500;
const AUTO_SYNC_HOURS = Number(process.env.GRINT_AUTO_SYNC_HOURS ?? 6);

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message) => ({ ...text(message), isError: true });

/**
 * A golfer's context: their cache and a lazily created TheGrint client.
 * Local mode has one; the hosted server keeps one per signed-in user.
 * Only one sync runs per context at a time.
 */
export class GolferContext {
  constructor({ cache, createClient }) {
    this.cache = cache;
    this.createClient = createClient;
    this.client = null;
    this.inFlight = null;
  }

  startSync(opts = {}) {
    this.inFlight ??= Promise.resolve()
      .then(() => (this.client ??= this.createClient()))
      .then((client) => syncRounds({ cache: this.cache, client, ...opts }))
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

// Keeps the cache fresh. With no data yet, the caller waits for a first sync
// (bounded, so the tool call doesn't time out). With stale data, the sync runs
// in the background and the query answers from the cache right away.
async function autoSync(ctx) {
  const empty = !ctx.cache.db.prepare("SELECT 1 FROM rounds LIMIT 1").get();
  if (!empty) {
    const last = ctx.cache.getMeta("last_sync");
    const stale = !last || Date.now() - Date.parse(last) > AUTO_SYNC_HOURS * 3600_000;
    if (stale && AUTO_SYNC_HOURS > 0)
      ctx.startSync({ budgetMs: 120_000 }).catch((e) => console.error(`Background sync failed: ${e.message}`));
    return null;
  }
  try {
    const r = await ctx.startSync({ budgetMs: 40_000 });
    if (r.remaining) {
      return `Note: sync is partial (${r.remaining} rounds still to fetch). Call sync_grint_data to finish, then re-run the query.`;
    }
    return r.synced ? `Synced ${r.synced} rounds from TheGrint first.` : null;
  } catch (e) {
    return `Note: could not sync from TheGrint (${e.message}).`;
  }
}

// Sent to the client on connect. Tells Claude when to reach for these tools,
// including casual golf questions that never mention TheGrint.
const INSTRUCTIONS = `These tools hold the user's golf history from TheGrint: every round and every hole they've logged.
Use them whenever the user asks about their own golf game, even if they don't mention TheGrint. For example:
- scores and scoring average, best or worst rounds, breaking 80/90/100, handicap and handicap differentials
- a specific hole or course ("how do I play 18 at Jimmy Clay?", "my home course", "the par 3s at Lions")
- birdies, pars, bogeys, doubles and blow-up holes
- putting (putts per round, 3-putts), greens in regulation (GIR), fairways hit and miss direction, penalties, water, OB, sand
- trends and comparisons: this year vs last, month by month, front nine vs back nine, one course vs another
- strategy or practice advice based on how they have actually played
Start with grint_overview to get exact course names, then answer with query_grint_data.`;

// Each transport (stdio, or one per HTTP request) gets its own McpServer.
export function createServer(ctx) {
  const server = new McpServer({ name: "grint", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "sync_grint_data",
    {
      title: "Sync TheGrint rounds",
      description:
        "Download your rounds and hole-by-hole scorecards from TheGrint into the local cache. " +
        "Incremental by default (only new or changed rounds). Each call runs for about 45 seconds; " +
        "if the result shows `remaining` > 0, call it again until it reaches 0. " +
        "Queries sync automatically when the data is stale, so you only need this for the first big import or to force a refresh.",
      inputSchema: {
        full_refresh: z.boolean().optional().describe("Re-download every round, not just new/changed ones."),
      },
    },
    async ({ full_refresh }) => {
      try {
        return text(await ctx.startSync({ fullRefresh: !!full_refresh }));
      } catch (e) {
        return fail(`Sync failed: ${e.message}`);
      }
    },
  );

  server.registerTool(
    "grint_overview",
    {
      title: "Overview of your golf data",
      description:
        "Summary of the user's golf history from TheGrint: how many rounds, date range, last sync time, and every " +
        "golf course they've played with its exact name, tees and round count. Call this first for any golf question " +
        "to find the exact course_name to use in SQL (e.g. to map 'jimmy clay' or 'my home course' to " +
        "'The Jimmy Clay Golf Course').",
      inputSchema: {},
    },
    async () => {
      const note = await autoSync(ctx);
      const { db } = ctx.cache;
      const totals = db
        .prepare("SELECT COUNT(*) AS rounds, MIN(date) AS first_round, MAX(date) AS last_round FROM rounds")
        .get();
      const courses = db
        .prepare(
          `SELECT course_name, COUNT(*) AS rounds, GROUP_CONCAT(DISTINCT tee) AS tees, MAX(date) AS last_played
         FROM rounds GROUP BY course_name ORDER BY rounds DESC`,
        )
        .all();
      return text({ note, ...totals, last_sync: ctx.cache.getMeta("last_sync"), courses });
    },
  );

  server.registerTool(
    "query_grint_data",
    {
      title: "Query your golf data with SQL",
      description: `Run a read-only SQLite query against the user's golf rounds and hole-by-hole scores from TheGrint.
Use it to answer any question about their golf game: scores, handicap, birdies/pars/bogeys, putts, greens in
regulation, fairways, penalties, specific holes or courses, and trends over time. Returns up to ${MAX_ROWS} rows as JSON.

Schema:
${SCHEMA_SQL}
${VIEWS_SQL}
Tips:
- Use the hole_details view for most hole-level questions; it already joins round info (date, course_name, tee).
- Match courses loosely: course_name LIKE '%jimmy clay%' (LIKE is case-insensitive). Call grint_overview if unsure of names.
- Only holes actually played have rows in holes. 9-hole rounds have round_type 'F9' or 'B9'.
- Pars on a hole: result = 'par' (or score_to_par = 0). Par or better: score_to_par <= 0.
- Fairways hit: fairway_hit, usually filtered to par > 3. GIR/putts are NULL for rounds where putts weren't tracked, so exclude NULLs in averages.
- Use practice = 0 to exclude practice rounds when that matters.

Example: "how many times have I parred hole 3 at Jimmy Clay"
  SELECT COUNT(*) FROM hole_details WHERE course_name LIKE '%jimmy clay%' AND hole = 3 AND result = 'par';`,
      inputSchema: {
        sql: z.string().describe("A single SELECT (or WITH ... SELECT) statement."),
      },
    },
    async ({ sql }) => {
      const note = await autoSync(ctx);
      try {
        const rows = ctx.cache.readOnly.prepare(sql).all();
        const out = { row_count: rows.length, rows: rows.slice(0, MAX_ROWS) };
        if (rows.length > MAX_ROWS) out.truncated = `Showing the first ${MAX_ROWS} rows; aggregate or add LIMIT.`;
        if (note) out.note = note;
        return text(out);
      } catch (e) {
        return fail(`SQL error: ${e.message}`);
      }
    },
  );

  return server;
}
