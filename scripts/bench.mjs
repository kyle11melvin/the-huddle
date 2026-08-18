// Latency benchmark — run with `node scripts/bench.mjs`.
// Fixture mirrors Kyle's real 16-man roster and a full-size ESPN snapshot so
// the numbers mean something. Reports medians of 5 runs.
import { suggestLineup } from "../src/analysis.js";
import { simulateLive, opponentDistributions } from "../src/simulate.js";

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (label, fn, runs = 5) => {
  fn(); // warm
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  const m = median(ts);
  console.log(`${label.padEnd(46)} median ${m.toFixed(1)} ms   (${ts.map((t) => t.toFixed(0)).join(", ")})`);
  return m;
};

// ---- Kyle's actual roster ----
const STARTERS = [
  ["Trevor Lawrence", "JAX", "QB", "QB11", 20.6],
  ["Bijan Robinson", "ATL", "RB", "RB2", 19.8],
  ["Chase Brown", "CIN", "RB", "RB9", 15.1],
  ["Tee Higgins", "CIN", "WR", "WR14", 14.2],
  ["Jameson Williams", "DET", "WR", "WR24", 12.7],
  ["Parker Washington", "JAX", "WR", "WR38", 9.4],
  ["Brock Bowers", "LV", "TE", "TE1", 16.3],
  ["Javonte Williams", "DAL", "RB", "RB14", 11.9],
  ["Steelers D/ST", "PIT", "D/ST", "DST7", 7.5],
  ["Cameron Dicker", "LAC", "K", "K5", 8.8],
];
const BENCH = [
  ["Quentin Johnston", "LAC", "WR", "WR38", 10.1],
  ["Makai Lemon", "PHI", "WR", "WR62", 6.2],
  ["Rachaad White", "TB", "RB", "RB33", 9.7],
  ["Brian Robinson Jr.", "SF", "RB", "RB41", 8.4],
  ["Romeo Doubs", "GB", "WR", "WR44", 8.9],
  ["Jayden Higgins", "HOU", "WR", "WR51", 7.1],
];
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "D/ST", "K"];

const players = {};
const analytics = {};
const lineup = { QB: [null], RB: [null, null], WR: [null, null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] };
const cursor = {};
STARTERS.forEach(([name, team, pos, ecr, proj], i) => {
  const id = `s${i}`;
  players[id] = { id, name, team, pos, ecr, status: "", espnId: String(1000 + i), notes: "", weeks: {} };
  analytics[id] = { 1: { proj, projSource: "espn" } };
  const slot = SLOTS[i];
  cursor[slot] = cursor[slot] || 0;
  lineup[slot][cursor[slot]++] = id;
});
const bench = BENCH.map(([name, team, pos, ecr, proj], i) => {
  const id = `b${i}`;
  players[id] = { id, name, team, pos, ecr, status: "", espnId: String(2000 + i), notes: "", weeks: {} };
  analytics[id] = { 1: { proj, projSource: "espn" } };
  return id;
});

// A full-size ESPN snapshot: 10 teams × 16 players + a 350-man pool.
const mkRoster = (t) =>
  Array.from({ length: 16 }, (_, i) => ({
    name: `Team${t} Player${i}`,
    pos: ["QB", "RB", "WR", "TE", "K", "D/ST"][i % 6],
    team: "KC",
    slot: i < 10 ? "QB" : "BE",
    proj: 8 + (i % 12),
    actual: null,
    espnId: String(t * 100 + i),
    injuryStatus: "",
    percentOwned: 50,
  }));
const espn = {
  fetchedAt: Date.now(),
  currentWeek: 1,
  myTeamId: 7,
  scoring: { passTd: 6, int: -3, reception: 1 },
  leagueFaab: 100,
  teams: Array.from({ length: 10 }, (_, t) => ({
    id: t + 1,
    name: `Team ${t + 1}`,
    mapped: `Team ${t + 1}`,
    record: { w: 0, l: 0, t: 0 },
    faabSpent: 0,
    roster: mkRoster(t + 1),
  })),
  matchups: [],
  games: {},
  impliedTotals: { KC: 26.5, BUF: 24.5, ATL: 22, CIN: 25, JAX: 21.5, DET: 27, LV: 19, PIT: 20, LAC: 23, DAL: 22.5 },
  pool: Array.from({ length: 350 }, (_, i) => ({
    espnId: String(9000 + i),
    name: `Pool Player ${i}`,
    pos: ["QB", "RB", "WR", "TE", "K", "D/ST"][i % 6],
    proTeamId: 12,
    team: "KC",
    onTeamId: i % 3 === 0 ? 0 : (i % 10) + 1,
    percentOwned: 100 - (i % 100),
    proj: 20 - (i % 18),
  })),
  autoRanks: Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`poolplayer${i}`, i + 1])),
};

const state = {
  v: 2,
  week: "1",
  players,
  lineup,
  bench,
  ir: [null, null],
  watch: [],
  calls: [],
  faab: 99,
  claims: [],
  byes: {},
  byesAuto: {},
  byesManual: {},
  ecrIndex: {},
  analytics,
  matchups: { 1: { oppTeam: "Team 3" } },
  espn,
  schedule: { opps: {}, fetchedAt: Date.now(), season: "2026" },
  alertsDismissed: {},
  orphans: [],
};

const oppDists = Array.from({ length: 10 }, (_, i) => ({
  id: `o${i}`,
  name: `Opp ${i}`,
  team: "KC",
  pos: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "RB", "D/ST", "K"][i],
  opp: "BUF",
  mean: 8 + i,
  sd: (8 + i) * 0.5,
}));

console.log("=== The Huddle latency benchmark ===");
console.log(`roster: ${Object.keys(players).length} players · bench ${bench.length} · pool ${espn.pool.length}\n`);

time("suggestLineup (win-prob scan, real roster)", () => suggestLineup(state, "1", oppDists));
time("suggestLineup (points fallback, no opponent)", () => suggestLineup(state, "1", null));

const liveEntries = (n) =>
  Array.from({ length: n }, (_, i) => ({
    proj: 10 + i,
    playProb: 1,
    scored: i * 2,
    pctRemaining: 0.5,
    status: "inProgress",
    cv: 0.5,
    team: "KC",
    pos: "WR",
    opp: "BUF",
  }));
time("simulateLive (Gameday headline, 20k runs)", () => simulateLive(liveEntries(10), liveEntries(10)));

time("JSON.stringify(state) — the localStorage write", () => JSON.stringify(state));
const bytes = JSON.stringify(state).length;
console.log(`\npersisted payload: ${(bytes / 1024).toFixed(0)} KB  (localStorage quota is ~5 MB)`);
console.log(`  of which espn.pool: ${(JSON.stringify(espn.pool).length / 1024).toFixed(0)} KB`);
console.log(`  of which espn.teams: ${(JSON.stringify(espn.teams).length / 1024).toFixed(0)} KB`);

// What the optimizer scan actually costs, in sims
const eligible = bench.filter((id) => ["RB", "WR", "TE"].includes(players[id].pos)).length;
console.log(`\nscan size: ${eligible} eligible bench × 6 flex-capable starting slots ≈ ${eligible * 6} sims/pass`);

// ---- SCAN_RUNS noise: how much does the win-prob DELTA move with fewer runs? ----
// The scan compares before/after with the SAME seed (common random numbers),
// so the delta is a paired estimate and far quieter than either endpoint.
import { simulateMatchup, lineupDistributions } from "../src/simulate.js";
import { pointDistribution } from "../src/analytics.js";

const deltasAt = (runs) => {
  const base = lineupDistributions(state, state.lineup, "1").dists;
  const before = simulateMatchup(base, oppDists, 12345, runs).winProb;
  const out = [];
  for (const inId of bench) {
    const inP = players[inId];
    const d = pointDistribution(inP, "1", state);
    for (const [slotKey, arr] of Object.entries(state.lineup)) {
      if (!["RB", "WR", "FLEX"].includes(slotKey)) continue;
      arr.forEach((outId) => {
        if (!outId) return;
        const swapped = base
          .filter((x) => x.id !== outId)
          .concat([{ id: inId, name: inP.name, team: inP.team, pos: inP.pos, opp: null, ...d }]);
        out.push(simulateMatchup(swapped, oppDists, 12345, runs).winProb - before);
      });
    }
  }
  return out;
};
const ref = deltasAt(8000);
console.log("\n=== win-prob delta noise vs the 8000-run reference ===");
for (const runs of [4000, 2000, 1500, 1000]) {
  const got = deltasAt(runs);
  const diffs = got.map((v, i) => Math.abs(v - ref[i]));
  const max = Math.max(...diffs);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const t0 = performance.now();
  deltasAt(runs);
  const ms = performance.now() - t0;
  console.log(
    `${String(runs).padStart(5)} runs  max drift ${(max * 100).toFixed(3)}%  mean ${(mean * 100).toFixed(3)}%  scan ${ms.toFixed(0)} ms`
  );
}
const t8 = performance.now(); deltasAt(8000); console.log(` 8000 runs  (reference)                               scan ${(performance.now()-t8).toFixed(0)} ms`);
console.log("reporting threshold MIN_WIN_DELTA = 1.000%");
