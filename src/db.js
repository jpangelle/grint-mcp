import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, constants } from "node:sqlite";
import { CONFIG_DIR } from "./credentials.js";

export const DB_PATH = process.env.GRINT_DB_PATH || path.join(CONFIG_DIR, "grint.db");

// Kept in one string so the MCP tool descriptions can show Claude the exact schema.
export const SCHEMA_SQL = `
-- You and your TheGrint friends (Mutual Following). Friends' rounds are only
-- present once synced (see rounds_synced).
CREATE TABLE IF NOT EXISTS golfers (
  id            TEXT PRIMARY KEY,   -- TheGrint user id
  name          TEXT,
  is_me         INTEGER NOT NULL DEFAULT 0,
  handicap      REAL,               -- as shown on TheGrint's Ranking page
  avg_score     REAL,               -- TheGrint's average score (last 20 rounds)
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id            TEXT PRIMARY KEY,   -- TheGrint score id
  golfer_id     TEXT,               -- who played it (golfers.id)
  date          TEXT,               -- YYYY-MM-DD
  course_id     TEXT,
  course_name   TEXT,               -- e.g. 'The Jimmy Clay Golf Course'
  tee           TEXT,               -- e.g. 'Blue'
  rating        REAL,
  slope         INTEGER,
  round_type    TEXT,               -- '18', 'F9' (front nine only), 'B9' (back nine only)
  holes_played  INTEGER,
  score         INTEGER,            -- gross score
  par           INTEGER,            -- total par of the holes actually played
  score_to_par  INTEGER,
  putts         INTEGER,
  gir_pct       REAL,               -- as shown by TheGrint (0-100)
  fir_pct       REAL,
  hdcp_diff     REAL,               -- handicap differential
  tournament    INTEGER,            -- 1 if a tournament score ('T')
  attested      INTEGER,
  practice      INTEGER,
  synced_at     TEXT
);

CREATE TABLE IF NOT EXISTS holes (
  round_id      TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  hole          INTEGER NOT NULL,   -- 1-18
  par           INTEGER,
  yardage       INTEGER,
  hcp_index     INTEGER,            -- stroke index (1 = hardest)
  strokes       INTEGER,
  score_to_par  INTEGER,            -- strokes - par
  result        TEXT,               -- 'albatross','eagle','birdie','par','bogey','double_bogey','triple_bogey','quad_plus'
  putts         INTEGER,            -- NULL if putts were not tracked that round
  gir           INTEGER,            -- 1/0 green in regulation (NULL if putts not tracked)
  fairway       TEXT,               -- 'hit','left','right','short','long','far_left','far_right','missed_ex' or NULL (not tracked)
  fairway_hit   INTEGER,            -- 1/0, NULL if not tracked. Usually only meaningful where par > 3
  penalties     TEXT,               -- raw TheGrint codes: s=greenside sand, f=fairway sand, w=water, o=out of bounds, d=drop/unplayable
  sand_shots    INTEGER,            -- count of s + f
  water         INTEGER,            -- count of w
  ob            INTEGER,            -- count of o
  drops         INTEGER,            -- count of d
  PRIMARY KEY (round_id, hole)
);

CREATE INDEX IF NOT EXISTS idx_rounds_course ON rounds(course_name);
CREATE INDEX IF NOT EXISTS idx_rounds_date ON rounds(date);

CREATE TABLE IF NOT EXISTS course_tees (
  course_id  TEXT NOT NULL,
  tee        TEXT NOT NULL,
  data       TEXT NOT NULL,         -- JSON: par/hcpIndex/yardage arrays
  PRIMARY KEY (course_id, tee)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

// Views are recreated on every open so their definitions stay current.
export const VIEWS_SQL = `
-- Every round with who played it.
CREATE VIEW round_details AS
SELECT r.*, g.name AS golfer_name, COALESCE(g.is_me, 0) AS is_me
FROM rounds r LEFT JOIN golfers g ON g.id = r.golfer_id;

-- Every hole joined with its round's details and golfer.
CREATE VIEW hole_details AS
SELECT h.*, r.golfer_id, g.name AS golfer_name, COALESCE(g.is_me, 0) AS is_me,
       r.date, r.course_id, r.course_name, r.tee, r.round_type,
       r.score AS round_score, r.tournament, r.practice
FROM holes h JOIN rounds r ON r.id = h.round_id LEFT JOIN golfers g ON g.id = r.golfer_id;
`;

// Databases created before friends support lack rounds.golfer_id.
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(rounds)").all().map((c) => c.name);
  if (!cols.includes("golfer_id")) db.exec("ALTER TABLE rounds ADD COLUMN golfer_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_rounds_golfer ON rounds(golfer_id)");
  db.exec("DROP VIEW IF EXISTS hole_details; DROP VIEW IF EXISTS round_details;");
  db.exec(VIEWS_SQL);
}

const READ_ACTIONS = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);

// One golfer's cached rounds. Local mode has a single cache; the hosted
// server keeps one file per TheGrint user so SQL can't reach anyone else's data.
export class Cache {
  constructor(dbPath = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    migrate(this.db);
    // A separate read-only connection for Claude-supplied SQL, so a query can
    // never modify the cache.
    this.readOnly = new DatabaseSync(dbPath, { readOnly: true });
    // Allow reads only. Denying everything else (ATTACH in particular) matters
    // on the hosted server, where other users' database files sit next to this one.
    this.readOnly.setAuthorizer((action) => (READ_ACTIONS.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY));
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  me() {
    return this.db.prepare("SELECT * FROM golfers WHERE is_me = 1").get() ?? null;
  }

  // Replace the friends list (keeps rows for ex-friends whose rounds are cached).
  saveGolfers(golfers) {
    const now = new Date().toISOString();
    const up = this.db.prepare(
      `INSERT INTO golfers (id, name, is_me, handicap, avg_score, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_me = excluded.is_me, handicap = excluded.handicap,
         avg_score = excluded.avg_score, updated_at = excluded.updated_at`
    );
    for (const g of golfers) up.run(g.userId, g.name, g.isMe ? 1 : 0, g.handicap ?? null, g.avgScore ?? null, now);
    // Anyone no longer in the list isn't a current friend.
    const ids = new Set(golfers.map((g) => g.userId));
    for (const { id } of this.db.prepare("SELECT id FROM golfers WHERE is_me = 0").all()) {
      if (!ids.has(id)) this.db.prepare("UPDATE golfers SET updated_at = NULL WHERE id = ?").run(id);
    }
    this.setMeta("friends_synced_at", now);
  }

  // Makes sure the signed-in user has a golfers row, and claims rounds synced
  // before friends support (which have no golfer_id).
  ensureMe(userId) {
    this.db.prepare("INSERT INTO golfers (id, is_me) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET is_me = 1").run(userId);
    this.db.prepare("UPDATE rounds SET golfer_id = ? WHERE golfer_id IS NULL").run(userId);
  }
}
