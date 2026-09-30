import { FAIRWAY_CODES, AuthError } from "./grint-client.js";

const CONCURRENCY = 4;

const RESULT_NAMES = { "-3": "albatross", "-2": "eagle", "-1": "birdie", 0: "par", 1: "bogey", 2: "double_bogey", 3: "triple_bogey" };
function resultName(diff) {
  if (diff === null) return null;
  if (diff <= -3) return "albatross";
  if (diff >= 4) return "quad_plus";
  return RESULT_NAMES[diff];
}

const count = (s, ch) => [...s].filter((c) => c === ch).length;

async function courseDataFor(c, db, { courseId, tee, roundType, scoreId }) {
  const key = [courseId, tee.toLowerCase()];
  const cached = db.prepare("SELECT data FROM course_tees WHERE course_id = ? AND tee = ?").get(...key);
  if (cached) return JSON.parse(cached.data);
  const data = await c.getCourseData({ courseId, tee, roundType, scoreId });
  db.prepare("INSERT OR REPLACE INTO course_tees (course_id, tee, data) VALUES (?, ?, ?)").run(...key, JSON.stringify(data));
  return data;
}

async function syncRound(c, db, summary) {
  const card = await c.getScorecard(summary);
  const tee = card.tee || summary.tee || "";
  const course = card.courseId
    ? await courseDataFor(c, db, { courseId: card.courseId, tee, roundType: card.roundType, scoreId: summary.id })
    : { par: [], hcpIndex: [], yardage: [] };

  const played = card.holes.filter((h) => h.strokes !== null);
  // TheGrint stores 0 putts when putts weren't tracked, so treat an all-zero round as "not tracked".
  const puttsTracked = played.some((h) => (h.putts ?? 0) > 0);

  const holeRows = played.map((h) => {
    const i = h.hole - 1;
    const par = course.par[i] ?? null;
    const diff = par !== null ? h.strokes - par : null;
    const putts = puttsTracked ? (h.putts ?? 0) : null;
    const fairway = FAIRWAY_CODES[h.fairwayCode] ?? null;
    return {
      hole: h.hole,
      par,
      yardage: course.yardage[i] ?? null,
      hcp_index: course.hcpIndex[i] ?? null,
      strokes: h.strokes,
      score_to_par: diff,
      result: resultName(diff),
      putts,
      gir: putts !== null && par !== null ? (h.strokes - putts <= par - 2 ? 1 : 0) : null,
      fairway,
      fairway_hit: fairway ? (fairway === "hit" ? 1 : 0) : null,
      penalties: h.penalties,
      sand_shots: count(h.penalties, "s") + count(h.penalties, "f"),
      water: count(h.penalties, "w"),
      ob: count(h.penalties, "o"),
      drops: count(h.penalties, "d"),
    };
  });

  const totalPar = holeRows.every((h) => h.par !== null) ? holeRows.reduce((a, h) => a + h.par, 0) : null;
  const totalStrokes = holeRows.reduce((a, h) => a + h.strokes, 0);
  const score = summary.score ?? (totalStrokes || null);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM holes WHERE round_id = ?").run(summary.id);
    db.prepare(
      `INSERT OR REPLACE INTO rounds (id, date, course_id, course_name, tee, rating, slope, round_type, holes_played,
         score, par, score_to_par, putts, gir_pct, fir_pct, hdcp_diff, tournament, attested, practice, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      summary.id,
      card.date || summary.date,
      card.courseId ?? null,
      card.courseName || summary.courseName,
      tee || null,
      summary.rating,
      summary.slope,
      card.roundType,
      summary.holesPlayed ?? played.length,
      score,
      totalPar,
      totalPar !== null && score !== null ? totalStrokes - totalPar : null,
      puttsTracked ? holeRows.reduce((a, h) => a + h.putts, 0) : summary.putts,
      summary.girPct,
      summary.firPct,
      summary.hdcpDiff,
      summary.tournament ? 1 : 0,
      summary.attested ? 1 : 0,
      summary.practice ? 1 : 0,
      new Date().toISOString()
    );
    const ins = db.prepare(
      `INSERT INTO holes (round_id, hole, par, yardage, hcp_index, strokes, score_to_par, result, putts, gir,
         fairway, fairway_hit, penalties, sand_shots, water, ob, drops)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const h of holeRows) {
      ins.run(summary.id, h.hole, h.par, h.yardage, h.hcp_index, h.strokes, h.score_to_par, h.result, h.putts, h.gir,
        h.fairway, h.fairway_hit, h.penalties, h.sand_shots, h.water, h.ob, h.drops);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Pulls rounds from TheGrint into the local SQLite cache.
 * Only new or changed rounds are fetched unless fullRefresh is set.
 * Stops after `budgetMs` so an MCP tool call doesn't time out; call again to continue.
 */
export async function syncRounds({ cache, client: c, fullRefresh = false, budgetMs = 45_000, onProgress }) {
  const started = Date.now();
  const { db } = cache;

  const summaries = await c.listAllRounds();
  const existing = new Map(
    db.prepare("SELECT id, score, tee, date FROM rounds").all().map((r) => [r.id, r])
  );

  // Rounds deleted on TheGrint get removed locally too.
  const liveIds = new Set(summaries.map((s) => s.id));
  let removed = 0;
  for (const id of existing.keys()) {
    if (!liveIds.has(id)) {
      db.prepare("DELETE FROM rounds WHERE id = ?").run(id);
      removed++;
    }
  }

  const todo = summaries.filter((s) => {
    if (fullRefresh) return true;
    const e = existing.get(s.id);
    return !e || e.score !== s.score || (s.tee && e.tee !== s.tee);
  });

  let done = 0;
  const errors = [];
  let queue = [...todo];
  const worker = async () => {
    while (queue.length && Date.now() - started < budgetMs) {
      const s = queue.shift();
      try {
        await syncRound(c, db, s);
      } catch (e) {
        if (e instanceof AuthError) throw e;
        errors.push(`${s.date} ${s.courseName} (id ${s.id}): ${e.message}`);
      }
      done++;
      onProgress?.(done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const remaining = queue.length;
  if (!remaining) cache.setMeta("last_sync", new Date().toISOString());
  return {
    totalRoundsOnGrint: summaries.length,
    synced: done - errors.length,
    removed,
    remaining,
    errors,
    lastCompleteSync: cache.getMeta("last_sync"),
  };
}
