import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SCHEMA_SQL, VIEWS_SQL } from "./db.js";
import { syncRounds, courseDataFor } from "./sync.js";

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
They also hold the rounds of the user's TheGrint friends (golfer_name / is_me columns), so they can compare against or answer questions about friends.
During a round in progress (for example a skins game), use get_live_scores to read today's hole-by-hole scores straight from TheGrint.
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
- Rounds include friends'. Filter is_me = 1 for the user's own game; use golfer_name LIKE '%stokes%' for a friend.

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

  server.registerTool(
    "get_live_scores",
    {
      title: "Today's round: group, handicaps and scores",
      description:
        "Fetch today's rounds straight from TheGrint (not the cache): yours, any friends you name, and with group=true " +
        "every friend with a round today at the same course as yours. Returns, for each golfer: course, tee, rating/slope/par, " +
        "handicap index and computed course handicap, and strokes per hole with par and stroke index. Use it to set up a " +
        "betting game (skins, Nassau) from the round the user created in TheGrint, and during the round to pick up new holes " +
        "without the user typing scores. Holes not yet entered are left out; a round with no holes saved yet may not appear. " +
        "Golfers named but without a round today are listed in not_found.",
      inputSchema: {
        players: z
          .array(z.string())
          .optional()
          .describe("Friends to include, by full or partial name as on TheGrint (e.g. 'Stokes', 'Eric Anderson'). You are always included."),
        group: z
          .boolean()
          .optional()
          .describe("Also find every friend playing today at the same course as you (no names needed). Slower: checks all friends."),
        date: z.string().optional().describe("YYYY-MM-DD. Defaults to today in `timezone`."),
        timezone: z.string().optional().describe("IANA time zone for 'today'. Defaults to America/Chicago."),
      },
    },
    async ({ players = [], group = false, date, timezone = "America/Chicago" }) => {
      try {
        const day = date ?? new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
        const client = (ctx.client ??= ctx.createClient());
        if (!client.loggedIn) await client.login();
        const { db } = ctx.cache;
        ctx.cache.ensureMe(client.userId);
        // Fresh handicap indexes come from the Ranking page.
        if (group || !db.prepare("SELECT 1 FROM golfers WHERE is_me = 0 LIMIT 1").get()) {
          ctx.cache.saveGolfers(await client.listFriends());
        }

        const me = String(client.userId);
        const wanted = new Set([me]);
        const unmatched = [];
        const ambiguous = [];
        for (const p of players) {
          const q = p.trim().toLowerCase();
          const hits = db
            .prepare("SELECT id, name FROM golfers WHERE is_me = 0 AND name LIKE ? ORDER BY updated_at IS NULL")
            .all(`%${p.trim()}%`);
          const exact = hits.find((h) => h.name?.toLowerCase() === q);
          if (!hits.length) unmatched.push(p);
          else if (hits.length > 1 && !exact) ambiguous.push({ query: p, matches: hits.map((h) => h.name) });
          else wanted.add(String((exact ?? hits[0]).id));
        }
        const named = new Set(wanted);
        if (group) {
          for (const { id } of db.prepare("SELECT id FROM golfers WHERE is_me = 0 AND updated_at IS NOT NULL").all()) wanted.add(String(id));
        }

        const live = await client.getLiveScoresList();
        const toFetch = new Map(live.scores.map((s) => [s.id, s]));
        const found = new Set();
        const ids = [...wanted];
        for (let i = 0; i < ids.length; i += 6) {
          await Promise.all(
            ids.slice(i, i + 6).map(async (gid) => {
              const rounds = await client.listRoundsFor(gid, { maxPages: 1 });
              for (const r of rounds.filter((r) => r.date === day)) {
                toFetch.set(r.id, { ...r, golferId: gid });
                found.add(gid);
              }
            }),
          );
        }

        const golfer = (id) => db.prepare("SELECT name, handicap FROM golfers WHERE id = ?").get(id) ?? {};
        let results = [];
        for (const r of toFetch.values()) {
          const card = await client.getScorecard(r);
          const course = card.courseId && card.tee
            ? await courseDataFor(client, db, { courseId: card.courseId, tee: card.tee, roundType: card.roundType, scoreId: r.id }).catch(() => null)
            : null;
          const holes = card.holes
            .filter((h) => h.strokes !== null)
            .map((h) => ({ hole: h.hole, strokes: h.strokes, par: course?.par[h.hole - 1] ?? null, hcp_index: course?.hcpIndex[h.hole - 1] ?? null }));
          const ownerId = String(card.ownerId ?? r.golferId ?? "");
          const g = golfer(ownerId);
          const rating = r.rating ?? course?.rating ?? null;
          const slope = r.slope ?? course?.slope ?? null;
          const par18 = course?.par?.length === 18 && course.par.every((p) => p !== null) ? course.par.reduce((a, b) => a + b, 0) : course?.coursePar ?? null;
          const courseHcp =
            g.handicap != null && rating != null && slope != null && par18 != null && card.roundType === "18"
              ? Math.round((g.handicap * slope) / 113 + (rating - par18))
              : null;
          results.push({
            golfer: g.name ?? ownerId,
            golfer_id: ownerId,
            is_me: ownerId === me,
            round_id: r.id,
            date: card.date,
            course: card.courseName || r.courseName || null,
            course_id: card.courseId ?? null,
            tee: card.tee,
            round_type: card.roundType,
            rating,
            slope,
            par: par18,
            handicap_index: g.handicap ?? null,
            course_handicap: courseHcp,
            holes_entered: holes.length,
            last_hole: holes.at(-1)?.hole ?? null,
            holes,
            scorecard: course ? { par: course.par, hcp_index: course.hcpIndex, yardage: course.yardage } : null,
          });
        }

        // In group mode, keep only rounds at the same course as yours (plus anyone named explicitly).
        const mine = results.find((x) => x.is_me);
        if (group && mine?.course_id) {
          results = results.filter((x) => x.course_id === mine.course_id || named.has(x.golfer_id));
        }
        // The full scorecard only needs sending once.
        results.forEach((x, i) => i > 0 && x.course_id === results[0].course_id && delete x.scorecard);

        return text({
          date: day,
          rounds: results,
          not_found: [...named].filter((id) => !found.has(id)).map((id) => golfer(id).name ?? id),
          unmatched_names: unmatched,
          ambiguous_names: ambiguous,
          note: "course_handicap is computed from the current handicap index (index x slope / 113 + rating - par). TheGrint's own number can differ by 1.",
          live_scores_list: live.text ? live : "empty (nobody shown as live on TheGrint's dashboard)",
        });
      } catch (e) {
        return fail(`Could not fetch live scores: ${e.message}`);
      }
    },
  );

  return server;
}
