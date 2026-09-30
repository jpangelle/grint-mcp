import * as cheerio from "cheerio";

// Unofficial client for thegrint.com. TheGrint has no public API, so this
// logs in like the website does (PHP session cookie) and scrapes the
// server-rendered score pages plus the JSON endpoints those pages call.

// Overridable so tests can point at a fake TheGrint.
const BASE = process.env.GRINT_BASE_URL || "https://thegrint.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Tee accuracy codes, taken from the site's review_full_scorecard.js keybindings.
export const FAIRWAY_CODES = {
  1: "left",
  2: "right",
  3: "hit",
  4: "short",
  5: "missed_ex",
  6: "long",
  7: "far_left",
  8: "far_right",
};

export class AuthError extends Error {}

export class GrintClient {
  // Either { username, password } (logs in with the form) or { rememberToken }
  // (TheGrint's 90-day "remember me" cookie, which restores a session by itself).
  constructor({ username, password, rememberToken } = {}) {
    this.username = username;
    this.password = password;
    this.rememberToken = rememberToken ?? null;
    this.rememberExpiresAt = null; // epoch seconds, known only after a password login
    this.cookies = new Map();
    this.userId = null;
    this.handicapCompanyId = "3";
    this.loggedIn = false;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  storeCookies(res) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "deleted" || value === "") {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, value);
      if (name === "remember") {
        this.rememberToken = value;
        const maxAge = attrs.map((a) => a.trim().match(/^max-age=(\d+)$/i)).find(Boolean);
        if (maxAge) this.rememberExpiresAt = Math.floor(Date.now() / 1000) + Number(maxAge[1]);
      }
    }
  }

  // Low-level request that follows redirects by hand so cookies set along
  // the way are kept. Returns { res, url, text }.
  async raw(pathOrUrl, { method = "GET", form } = {}) {
    let url = new URL(pathOrUrl, BASE).toString();
    let body = form ? new URLSearchParams(form).toString() : undefined;
    for (let hop = 0; hop < 10; hop++) {
      const headers = { "User-Agent": UA, Cookie: this.cookieHeader() };
      if (body !== undefined) {
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        headers["X-Requested-With"] = "XMLHttpRequest";
      }
      const res = await fetch(url, { method, headers, body, redirect: "manual" });
      this.storeCookies(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location"), url).toString();
        method = "GET";
        body = undefined;
        continue;
      }
      return { res, url, text: await res.text() };
    }
    throw new Error(`Too many redirects fetching ${pathOrUrl}`);
  }

  async login() {
    this.cookies.clear();
    if (this.password) {
      await this.raw("/login");
      const { url } = await this.raw("/login", {
        method: "POST",
        form: {
          username: this.username,
          password: this.password,
          redirect: "",
          "submit-form-login": "Log In",
          remember: "on",
        },
      });
      if (isLoggedOutUrl(url)) throw new AuthError("TheGrint login failed. Check your username and password.");
    } else if (this.rememberToken) {
      this.cookies.set("remember", this.rememberToken);
    } else {
      throw new AuthError("No TheGrint credentials.");
    }
    // The scores page carries the user id and handicap provider we need later.
    const { text, url: scoreUrl } = await this.raw("/score");
    if (isLoggedOutUrl(scoreUrl)) {
      throw new AuthError(
        this.password
          ? "TheGrint login did not stick (redirected to login)."
          : "Your TheGrint sign-in has expired. Reconnect the Grint connector in Claude to sign in again."
      );
    }
    const $ = cheerio.load(text);
    this.userId = $("#filterUserIdScore").val();
    const hc = text.match(/var handicapCompanyId = '(\d+)'/);
    if (hc) this.handicapCompanyId = hc[1];
    if (!this.userId) throw new AuthError("Logged in, but could not find your user id on the scores page.");
    this.loggedIn = true;
  }

  // Authenticated request; re-logs in once if the session has expired.
  async request(path, opts = {}) {
    if (!this.loggedIn) await this.login();
    let out = await this.raw(path, opts);
    if (isLoggedOutUrl(out.url)) {
      await this.login();
      out = await this.raw(path, opts);
      if (isLoggedOutUrl(out.url)) throw new AuthError(`Session rejected fetching ${path}`);
    }
    if (!out.res.ok) throw new Error(`HTTP ${out.res.status} fetching ${path}`);
    return out.text;
  }

  // Your friends ("Mutual Following"), from the data the Ranking page embeds.
  // Includes you (isMe). Friends who hide their stats are left out.
  async listFriends() {
    return parseRankingGolfers(await this.request("/ranking")).filter((g) => g.isMe || g.visible);
  }

  // Every round in the user's history (summary rows from the scores table).
  async listAllRounds() {
    const first = await this.request("/score?type_score=0");
    const rounds = parseScoreRows(`<table><tbody>${extractScoreTbody(first)}</tbody></table>`);
    let offset = rounds.length;
    for (let wave = 1; wave < 500; wave++) {
      const html = await this.request("/score/listMoreScores", {
        method: "POST",
        form: {
          wave,
          wave18: offset,
          wave9: offset,
          userId: this.userId,
          courseId: "",
          typeScore: 0,
          handicap_company_id: this.handicapCompanyId,
        },
      });
      const page = parseScoreRows(`<table><tbody>${html}</tbody></table>`);
      if (!page.length) break;
      rounds.push(...page);
      offset += page.length;
    }
    // De-dupe in case pagination overlapped.
    return [...new Map(rounds.map((r) => [r.id, r])).values()];
  }

  // Hole-by-hole data for one round, from its scorecard page.
  async getScorecard(round) {
    const path = `/score/edit_score/${round.id}${round.nine ? `/${round.nine}` : ""}?handicap_company_id=${this.handicapCompanyId}`;
    const html = await this.request(path);
    return parseScorecard(html);
  }

  // Par, stroke index and yardage per hole for a course + tee.
  async getCourseData({ courseId, tee, roundType, scoreId }) {
    const text = await this.request("/ajax/get_course_data/0/0/0", {
      method: "POST",
      form: {
        course_id: courseId,
        tee: tee.toLowerCase(),
        user_id: this.userId,
        round: roundType,
        score_id: scoreId,
        handicap_company_id: this.handicapCompanyId,
      },
    });
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected course data response for course ${courseId}/${tee}`);
    }
    const cells = (html) =>
      cheerio
        .load(`<table><tr>${html ?? ""}</tr></table>`)("td.data-entry")
        .map((_, td) => cheerio.load(td).text().trim())
        .get()
        .map((v) => (v === "" ? null : Number(v)));
    return {
      par: cells(data.par),
      hcpIndex: cells(data.handicap),
      yardage: cells(data.yardage),
      coursePar: data.coursePar ?? null,
      rating: num(data.rating),
      slope: num(data.slope),
    };
  }
}

function isLoggedOutUrl(url) {
  const p = new URL(url).pathname;
  return p.startsWith("/passthru") || p === "/login" || p === "/";
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractScoreTbody(html) {
  const $ = cheerio.load(html);
  return $("table.tableListScore > tbody").html() ?? $("table.tableListScore").html() ?? "";
}

// The Ranking page builds its leaderboard from inline JS:
//   allstats.push({ user_id: '123', ..., name: 'Sam', isme:0, hcp: ..., scr: '88.4', ..., is_visible:'1' });
export function parseRankingGolfers(html) {
  const golfers = [];
  for (const m of html.matchAll(/allstats\.push\(\{([\s\S]*?)\}\);/g)) {
    const body = m[1];
    const field = (name) => body.match(new RegExp(`\\b${name}:\\s*'([^']*)'`))?.[1];
    const userId = field("user_id");
    if (!userId) continue;
    golfers.push({
      userId,
      name: field("name")?.replace(/&#39;/g, "'").replace(/&amp;/g, "&") ?? null,
      isMe: /\bisme:\s*1\b/.test(body),
      visible: field("is_visible") !== "0",
      avgScore: num(field("scr")),
    });
  }
  // Handicap is assigned through a variable just before each push, e.g. var hcpOrhcpGhap = (provider==7)?'12.3':'12.3';
  const hcps = [...html.matchAll(/var hcpOrhcpGhap = \(provider==7\)\?'[^']*':'([^']*)'/g)].map((m) => num(m[1]));
  golfers.forEach((g, i) => (g.handicap = hcps[i] ?? null));
  return golfers;
}

// Parses <tr> rows from the "My Scores" table.
// Columns: date, course/tee, score, holes, putts, GIR, FIR, hdcp diff,
// T-score, attested, practice, view/delete.
export function parseScoreRows(html) {
  const $ = cheerio.load(html);
  const rounds = [];
  $("tbody > tr").each((_, tr) => {
    const tds = $(tr).children("td");
    const link = $(tr).find('a[href*="/score/edit_score/"]').attr("href");
    if (!link) return;
    const m = link.match(/edit_score\/(\d+)(?:\/(\d+))?/);
    if (!m) return;

    const courseCell = tds.eq(1);
    const teeLine = courseCell.find("p").text().replace(/\s+/g, " ").trim();
    const courseName = courseCell
      .clone()
      .children()
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\(\d+\)\s*/, "");
    const tm = teeLine.match(/^(.*?)\s+([\d.]+)\s*\|\s*(\d+)$/);
    const scoreText = tds.eq(2).text().trim();
    const [mm, dd, yy] = tds.eq(0).text().trim().split("/");

    rounds.push({
      id: m[1],
      nine: m[2] ?? null,
      date: yy ? `20${yy.padStart(2, "0")}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}` : null,
      courseName,
      tee: tm ? tm[1] : teeLine || null,
      rating: tm ? num(tm[2]) : null,
      slope: tm ? num(tm[3]) : null,
      score: num(scoreText),
      tournament: /T/i.test(scoreText),
      holesPlayed: num(tds.eq(3).text()),
      putts: num(tds.eq(4).text()),
      girPct: num(tds.eq(5).text()),
      firPct: num(tds.eq(6).text()),
      hdcpDiff: num(tds.eq(7).text()),
      attested: tds.eq(9).find("img").length > 0,
      practice: tds.eq(10).text().trim() !== "" || tds.eq(10).find("img").length > 0,
    });
  });
  return rounds;
}

// Parses the scorecard (edit_score) page into per-hole arrays (index 0 = hole 1).
export function parseScorecard(html) {
  const $ = cheerio.load(html);
  const val = (sel) => $(sel).first().val();
  const selected = (name) => {
    const s = $(`select[name="${name}"]`);
    return s.find("option[selected]").attr("value") ?? s.val();
  };
  const holes = [];
  for (let h = 1; h <= 18; h++) {
    const strokes = num(val(`input[name="scH${h}"]`));
    holes.push({
      hole: h,
      strokes: strokes && strokes > 0 ? strokes : null,
      putts: num(val(`input[name="ptH${h}"]`)),
      penalties: (val(`input[name="pH${h}"]`) ?? "").trim().toLowerCase(),
      fairwayCode: num(val(`input[name="fH${h}"]`)) ?? 0,
    });
  }
  const year = selected("year");
  const month = selected("month");
  const day = selected("date");
  return {
    ownerId: val('input[name="userid1"]') ?? null, // the golfer who played the round
    roundType: val("#round") ?? val('input[name="round"]') ?? "18",
    courseId: val('input[name="course"]'),
    courseName: val('input[name="cname"]'),
    tee: val(".tees-db") ?? val('input[name="tees-db"]'),
    date: year && month && day ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null,
    holes,
  };
}
