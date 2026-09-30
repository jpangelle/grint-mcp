// Offline test: runs the full sync -> SQLite -> query path against markup
// copied from thegrint.com, with the network layer stubbed out.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grint-test-"));
process.env.GRINT_DB_PATH = path.join(tmp, "test.db");
process.env.GRINT_USERNAME = "test";
process.env.GRINT_PASSWORD = "test";

const { GrintClient, parseScoreRows } = await import("../src/grint-client.js");
const { localContext } = await import("../src/local.js");
const ctx = localContext();
const syncRounds = () => ctx.startSync();
const getReadOnlyDb = () => ctx.cache.readOnly;

const row = (date, course, tee, score, holes, link) => `<tr class=" clickable-row"> <td class="text-helvetica text-14"> ${date} </td> <td class="text-18"> ${course} <p class="text-14 text-helvetica mb-0"> ${tee} </p> </td> <td> <div class="tg-circle"> <div class="green"> ${score} </div> </div> </td> <td> <div class="tg-border-circle"> <div class="white-b-green"> ${holes} </div> </div> </td> <td> <div class="tg-border-circle"> <div class="white-b-green"> 30 </div> </div> </td> <td> <div class="tg-border-circle"> <div class="white-b-green"> 22% </div> </div> </td> <td> </td> <td class="text-center text-20 "> <div class=""> <div class=""> 11.3 </div> </div> </td> <td class="text-center"> </td> <td class="text-center"> <img src="https://thegrint.com/assets/images/icons/tg_icon_attest_dgray.png" class="icon-image-m"> </td> <td class="text-center"> </td> <td class="text-center"> <a href="https://thegrint.com/score/edit_score/${link}?handicap_company_id=3" class="link-score view-link-score">View</a> </td> </tr>`;

const scorePage = `<html><body><input type="hidden" id="filterUserIdScore" value="1000001"><table class="tableListScore"><tbody>
${row("08/26/26", "The Jimmy Clay Golf Course", "Blue 71.10 | 129", "84", 18, "50000001")}
${row("07/20/26", "The Jimmy Clay Golf Course", "Black 73.80 | 124", "95T", 18, "50000002")}
</tbody></table></body></html>`;
const moreScores = row("06/09/26", "(9) The Jimmy Clay Golf Course", "White 34.80 | 123", "51", 9, "50000003/9");

function card({ round, tee, strokes, putts, fairways = [], penalties = [], date }) {
  const inputs = [];
  for (let h = 1; h <= 18; h++) {
    inputs.push(`<input class="input-score-field" type="number" data-value="${strokes[h - 1]}" value="${strokes[h - 1]}" name="scH${h}">`);
    inputs.push(`<input type="number" class="input-score-field" value="${putts[h - 1]}" name="ptH${h}">`);
    inputs.push(`<input type="text" value="${penalties[h - 1] ?? ""}" name="pH${h}">`);
    inputs.push(`<input type="hidden" name="fH${h}" value="${fairways[h - 1] ?? 0}">`);
  }
  const [y, m, d] = date.split("-");
  return `<html><body><form><input type="hidden" id="round" value="${round}"><input type="hidden" name="course" id="cid" value="7092"><input type="hidden" class="tees-db" value="${tee}">${inputs.join("")}
<select name="year"><option value="2020">2020</option><option value="${y}" selected="">${y}</option></select>
<select name="month"><option value="01">01</option><option value="${m}" selected="">${m}</option></select>
<select name="date"><option value="01">01</option><option value="${d}" selected="">${d}</option></select></form></body></html>`;
}

// Real Jimmy Clay par / index rows (Blue tees).
const PAR = [4, 3, 4, 5, 3, 4, 5, 4, 4, 5, 4, 3, 4, 3, 4, 5, 4, 4];
const IDX = [7, 15, 3, 9, 17, 11, 13, 1, 5, 8, 10, 14, 6, 12, 16, 18, 4, 2];
const tds = (arr, cls) =>
  `<td class="role gray-text">x<span></td>` +
  arr.map((v, i) => `<td class="data-entry ${i < 9 ? "section-out" : "section-in"} ${cls} ${i + 1}">${v}</td>`).join("") +
  `<td class="subtotal section-in gray-text">36</td><td class="total gray-text"></td>`;
const courseData = JSON.stringify({ par: tds(PAR, "gray-text"), handicap: tds(IDX, "gray-text"), yardage: tds(PAR.map((p) => p * 100), ""), coursePar: 72, rating: "71.10", slope: "129" });

const pages = {
  "/score?type_score=0": scorePage,
  "/score/edit_score/50000001?handicap_company_id=3": card({
    round: "18", tee: "Blue", date: "2026-08-26",
    strokes: [6, 4, 4, 7, 4, 4, 7, 5, 5, 4, 4, 3, 4, 4, 3, 6, 5, 5],
    putts: [3, 2, 1, 2, 2, 2, 2, 1, 2, 1, 1, 1, 2, 2, 1, 2, 1, 2],
    fairways: [3, 0, 1, 2],
    penalties: ["", "", "w", "os"],
  }),
  "/score/edit_score/50000002?handicap_company_id=3": card({
    round: "18", tee: "Black", date: "2026-07-20",
    strokes: [4, 3, 4, 5, 3, 4, 5, 4, 4, 5, 4, 3, 4, 3, 4, 5, 4, 23],
    putts: Array(18).fill(0),
  }),
  "/score/edit_score/50000003/9?handicap_company_id=3": card({
    round: "B9", tee: "White", date: "2026-06-09",
    strokes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 5, 4, 8, 5, 6, 5, 5, 8],
    putts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 3, 2, 3, 1, 1, 2, 2],
  }),
};

let wave = 0;
GrintClient.prototype.login = async function () {
  this.userId = "1000001";
  this.loggedIn = true;
};
GrintClient.prototype.request = async function (p, opts = {}) {
  if (p === "/score/listMoreScores") return wave++ === 0 ? moreScores : "\n<script>/* empty page */</script>";
  if (p === "/ajax/get_course_data/0/0/0") return courseData;
  if (!(p in pages)) throw new Error(`unexpected request ${p}`);
  return pages[p];
};

// --- parser unit checks
const parsed = parseScoreRows(scorePage);
assert.equal(parsed.length, 2);
assert.deepEqual(
  { ...parsed[1], attested: undefined },
  { id: "50000002", nine: null, date: "2026-07-20", courseName: "The Jimmy Clay Golf Course", tee: "Black", rating: 73.8, slope: 124, score: 95, tournament: true, holesPlayed: 18, putts: 30, girPct: 22, firPct: null, hdcpDiff: 11.3, attested: undefined, practice: false }
);
assert.equal(parseScoreRows(`<table><tbody>${moreScores}</tbody></table>`)[0].nine, "9");

// --- full sync
const result = await syncRounds();
assert.equal(result.synced, 3, JSON.stringify(result));
assert.equal(result.remaining, 0);

const q = (sql) => getReadOnlyDb().prepare(sql).all();
const pars3 = q(`SELECT COUNT(*) n FROM hole_details WHERE course_name LIKE '%jimmy clay%' AND hole = 3 AND result = 'par'`)[0].n;
assert.equal(pars3, 2); // 8/26 (4 on a par 4) and 7/20
const r1 = q(`SELECT * FROM rounds WHERE id = '50000001'`)[0];
assert.equal(r1.par, 72);
assert.equal(r1.score_to_par, 84 - 72);
const h3 = q(`SELECT * FROM holes WHERE round_id = '50000001' AND hole = 3`)[0];
assert.equal(h3.gir, 0); // 4 strokes, 1 putt, par 4 = on in 3, not GIR
assert.equal(q(`SELECT gir FROM holes WHERE round_id = '50000001' AND hole = 10`)[0].gir, 1); // par 5, 4 strokes, 1 putt
assert.equal(h3.fairway, "left");
assert.equal(h3.water, 1);
const h4 = q(`SELECT * FROM holes WHERE round_id = '50000001' AND hole = 4`)[0];
assert.deepEqual([h4.ob, h4.sand_shots, h4.result], [1, 1, "double_bogey"]);
const noPutts = q(`SELECT COUNT(*) n FROM holes WHERE round_id = '50000002' AND putts IS NOT NULL`)[0].n;
assert.equal(noPutts, 0);
const b9 = q(`SELECT round_type, holes_played, par, (SELECT MIN(hole) FROM holes WHERE round_id = r.id) first_hole FROM rounds r WHERE id = '50000003'`)[0];
assert.deepEqual({ ...b9 }, { round_type: "B9", holes_played: 9, par: 36, first_hole: 10 });

// Read-only connection must reject writes.
assert.throws(() => getReadOnlyDb().prepare("DELETE FROM rounds").run());

// Incremental sync fetches nothing new.
wave = 0;
assert.equal((await syncRounds()).synced, 0);

console.log("All offline tests passed.");
fs.rmSync(tmp, { recursive: true, force: true });
