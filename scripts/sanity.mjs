// Engine + data-integrity sanity checks — run with `npm test`.
// Guards the behaviours the app's honesty depends on:
//   1. scoring uses league values (6-pt pass TDs, rush attempts)
//   2. injury risk is bimodal (Q = 77% × outcome, floor 0)
//   3. correlation: stacked lineups are WIDER, QB-vs-opposing-D/ST narrower
//   4. migrate never silently deletes a player, never double-places one
//   5. ESPN sync seats every player it can and REPORTS the ones it can't
//   6. one failed week fetch must not fabricate a league-wide bye
import { propsToPoints, SCORING, parseProps } from "../src/props.js";
import { suggestLineup } from "../src/analysis.js";
import { extractScoring } from "../api/espn.js";
import { pointDistribution, floorCeiling } from "../src/analytics.js";
import { simulateMatchup } from "../src/simulate.js";
import { migrate } from "../src/lineup.js";
import { applyEspnSync } from "../src/espnSync.js";
import { deriveSchedule } from "../api/schedule.js";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ---- 1. scoring ----
const qb = propsToPoints({ passYds: 250, passTds: 1.5, ints: 0.5 });
check("6-pt passing TDs, −3 INTs", Math.abs(qb.points - (250 * 0.04 + 1.5 * 6 + 0.5 * -3)) < 0.06, `got ${qb.points}, want 17.5`);
const rb = propsToPoints({ rushYds: 80, rushAtt: 18 });
check("rush attempts score 1/5", Math.abs(rb.points - (8 + 3.6)) < 0.06, `got ${rb.points}, want 11.6`);
check("default passTd is 6", SCORING.passTd === 6);

// ---- 2. bimodal injury ----
const mkState = (proj) => ({ analytics: { p1: { 1: { proj } } }, espn: null });
const healthy = pointDistribution({ id: "p1", name: "X", pos: "WR", team: "KC", status: "" }, "1", mkState(12));
const quest = pointDistribution({ id: "p1", name: "X", pos: "WR", team: "KC", status: "Q" }, "1", mkState(12));
check("Q expected mean = 0.77 × proj", Math.abs(quest.mean - 12 * 0.77) < 0.1, `got ${quest.mean}`);
check("Q conditional mean unchanged", Math.abs(quest.condMean - 12) < 0.1, `got ${quest.condMean}`);
check("healthy unchanged", Math.abs(healthy.mean - 12) < 0.1 && healthy.playProb === 1);
const fc = floorCeiling(quest);
check("Q floor is zero (real chance of a donut)", fc.floor === 0, `got ${fc.floor}`);

// ---- 3. correlation ----
const OPP = [{ name: "them", mean: 34, sd: 11, team: null, opp: null, pos: "QB" }];
const spread = (r) => r.myP90 - r.myP10;

const stacked = simulateMatchup(
  [
    { name: "QB", team: "KC", opp: "DEN", pos: "QB", mean: 20, sd: 6.4 },
    { name: "WR", team: "KC", opp: "DEN", pos: "WR", mean: 15, sd: 8.7 },
  ],
  OPP
);
const unstacked = simulateMatchup(
  [
    { name: "QB", team: "KC", opp: "DEN", pos: "QB", mean: 20, sd: 6.4 },
    { name: "WR", team: "DAL", opp: "PHI", pos: "WR", mean: 15, sd: 8.7 },
  ],
  OPP
);
check(
  "stacked QB+WR is wider than unstacked (identical marginals)",
  spread(stacked) > spread(unstacked) * 1.03,
  `stacked P10–P90 ${spread(stacked).toFixed(1)} vs unstacked ${spread(unstacked).toFixed(1)}`
);

const hedged = simulateMatchup(
  [
    { name: "QB", team: "KC", opp: "DEN", pos: "QB", mean: 20, sd: 6.4 },
    { name: "DST", team: "DEN", opp: "KC", pos: "D/ST", mean: 15, sd: 8.7 },
  ],
  OPP
);
check(
  "QB vs opposing D/ST is narrower than unstacked (hedge)",
  spread(hedged) < spread(unstacked) * 0.97,
  `hedged ${spread(hedged).toFixed(1)} vs unstacked ${spread(unstacked).toFixed(1)}`
);

// means must be preserved by the copula (correlation reshapes joints, not marginals)
check(
  "correlation preserves totals (margin sanity)",
  Math.abs(stacked.margin - unstacked.margin) < 0.6,
  `margins ${stacked.margin} vs ${unstacked.margin}`
);

// ---- 4. symmetric matchup ≈ coin flip ----
const A = [
  { name: "a1", mean: 20, sd: 6, team: null, opp: null, pos: "QB" },
  { name: "a2", mean: 15, sd: 8, team: null, opp: null, pos: "WR" },
];
const B = [
  { name: "b1", mean: 20, sd: 6, team: null, opp: null, pos: "QB" },
  { name: "b2", mean: 15, sd: 8, team: null, opp: null, pos: "WR" },
];
const even = simulateMatchup(A, B, 777);
check("identical lineups ≈ 50% win", Math.abs(even.winProb - 0.5) < 0.02, `got ${(even.winProb * 100).toFixed(1)}%`);

// ---- 5. migrate: never lose a player, never place one twice ----
const mkPlayers = (n) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`p${i}`, { id: `p${i}`, name: `Player ${i}`, team: "KC", pos: "WR" }])
  );
const emptyLineup = { QB: [null], RB: [null, null], WR: [null, null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] };

// 10 players, nothing placed, 6 bench slots → 6 seated, 4 unplaceable.
// The 4 must SURVIVE (they used to be `delete`d, losing notes/ECR/history).
const orphanState = migrate({
  v: 2,
  week: "1",
  players: mkPlayers(10),
  lineup: emptyLineup,
  bench: [null, null, null, null, null, null],
  ir: [null, null],
});
check(
  "migrate keeps unplaceable players instead of deleting them",
  Object.keys(orphanState.players).length === 10,
  `kept ${Object.keys(orphanState.players).length}/10`
);
check(
  "migrate reports the orphans it couldn't seat",
  Array.isArray(orphanState.orphans) && orphanState.orphans.length === 4,
  `orphans: ${JSON.stringify((orphanState.orphans || []).map((o) => o.name))}`
);

// Same player in a lineup slot AND on the bench must end up in exactly one.
const dupeState = migrate({
  v: 2,
  week: "1",
  players: mkPlayers(3),
  lineup: { ...emptyLineup, QB: ["p0"] },
  bench: ["p0", "p1", null, null, null, null],
  ir: [null, null],
});
const zoneCount = (s, id) => {
  let n = 0;
  for (const arr of Object.values(s.lineup)) n += arr.filter((x) => x === id).length;
  n += s.bench.filter((x) => x === id).length;
  n += s.ir.filter((x) => x === id).length;
  return n;
};
check("migrate places a duplicated player in exactly one zone", zoneCount(dupeState, "p0") === 1, `found in ${zoneCount(dupeState, "p0")} zones`);

// ---- 6. applyEspnSync: seat everyone, or say who didn't fit ----
const rosterEntry = (i, slot) => ({
  espnId: String(1000 + i),
  name: `Sync Player ${i}`,
  pos: "RB",
  proTeamId: 12,
  slot,
  injuryStatus: "",
  percentOwned: 1,
  proj: 5,
  actual: null,
});
// 7 bench-bound + 2 IR in a league that reports 7 bench and 2 IR slots.
const nineMan = [
  ...Array.from({ length: 7 }, (_, i) => rosterEntry(i, "BE")),
  rosterEntry(7, "IR"),
  rosterEntry(8, "IR"),
];
const baseState = migrate({ v: 2, week: "1", players: {}, lineup: emptyLineup, bench: [null], ir: [null] });
const mkData = (rosterSlots) => ({
  currentWeek: 1,
  rosterSlots,
  leagueFaab: 100,
  teams: [{ id: 7, name: "Test Team", roster: nineMan, faabSpent: 0, record: null }],
  matchups: [],
  pool: [],
  games: {},
  impliedTotals: {},
});

const sync7 = applyEspnSync(baseState, mkData({ 20: 7, 21: 2 }), "Test Team");
const seated = (s) => s.bench.filter(Boolean).length + s.ir.filter(Boolean).length;
check(
  "ESPN sync seats all 9 when the league reports 7 bench + 2 IR",
  seated(sync7.state) === 9 && sync7.summary.overflow.length === 0,
  `seated ${seated(sync7.state)}/9, overflow ${JSON.stringify(sync7.summary.overflow)}`
);
check(
  "ESPN sync honours the league's bench size over the constant",
  sync7.state.bench.length === 7 && sync7.state.ir.length === 2,
  `bench ${sync7.state.bench.length}, ir ${sync7.state.ir.length}`
);

// Same roster, but the league reports nothing → fall back to 6 bench / 2 IR.
// Both real IR players must still get IR slots (they used to be evicted by
// bench overflow), and the player who genuinely doesn't fit is REPORTED.
const syncFallback = applyEspnSync(baseState, mkData(null), "Test Team");
const irNames = syncFallback.state.ir.filter(Boolean).map((id) => syncFallback.state.players[id].name);
check(
  "IR players keep their IR slots when bench overflows",
  irNames.includes("Sync Player 7") && irNames.includes("Sync Player 8"),
  `IR holds ${JSON.stringify(irNames)}`
);
check(
  "the player who doesn't fit is reported, not dropped",
  syncFallback.summary.overflow.length === 1 &&
    Object.keys(syncFallback.state.players).length === 9,
  `overflow ${JSON.stringify(syncFallback.summary.overflow)}, players ${Object.keys(syncFallback.state.players).length}`
);

// ---- 7. schedule completeness: one failed week must not fake a bye ----
const week = (n) => ({
  events: Array.from({ length: 16 }, (_, g) => ({
    competitions: [
      {
        competitors: [
          { homeAway: "home", team: { abbreviation: `H${g}` } },
          { homeAway: "away", team: { abbreviation: `A${g}` } },
        ],
      },
    ],
  })),
});
const fullSeason = Array.from({ length: 18 }, (_, i) => week(i + 1));
const good = deriveSchedule(fullSeason);
check("a clean 18-week sweep is complete", good.complete === true, `complete=${good.complete}, teams=${good.teamsSeen}`);

const oneFailed = fullSeason.map((w, i) => (i === 5 ? null : w)); // ESPN 503 on week 6
const bad = deriveSchedule(oneFailed);
check(
  "one failed week → complete:false",
  bad.complete === false && bad.failedWeeks.length === 1 && bad.failedWeeks[0] === 6,
  `complete=${bad.complete}, failed=${JSON.stringify(bad.failedWeeks)}`
);
check(
  "one failed week → NO byes derived (no phantom league-wide bye)",
  Object.keys(bad.byes).length === 0,
  `derived ${Object.keys(bad.byes).length} byes`
);

// ---- 8. scorePlayer: one scale, not two (finding 7) ----
// A projected starter must outrank an unprojected bench player whose only
// credential is an ECR string. The old code compared points×10 (≈0–350)
// against 200−rank (≈100–200), so WR38-with-no-projection beat WR14-with-12.
// QBs on purpose: one QB slot and FLEX doesn't accept them, so the two
// players genuinely COMPETE. (With WRs they'd both just start — three WR
// slots for two players — and no swap would ever be proposed.)
const mkLineupState = () => ({
  v: 2,
  week: "1",
  players: {
    a: { id: "a", name: "Projected Starter", team: "KC", pos: "QB", ecr: "QB14", status: "" },
    b: { id: "b", name: "Unprojected Bench", team: "BUF", pos: "QB", ecr: "QB38", status: "" },
  },
  lineup: { QB: ["a"], RB: [null, null], WR: [null, null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: ["b", null, null, null, null, null],
  ir: [null, null],
  byes: {},
  byesAuto: {},
  byesManual: {},
  analytics: { a: { 1: { proj: 12, projSource: "espn" } } }, // b has none
  espn: null,
  ecrIndex: {},
  schedule: null,
  matchups: {},
});
const scaleMoves = suggestLineup(mkLineupState(), "1", null);
const badSwap = scaleMoves.find((m) => m.inId === "b" && m.outId === "a");
check(
  "optimizer does not bench a projected starter for an unprojected bench player",
  !badSwap,
  badSwap ? `recommended "${badSwap.inName} over ${badSwap.outName}" (gain ${badSwap.gain})` : "no bad swap"
);

// ---- 9. props parser: market names must not match inside other words ----
// "Longest Reception" comes BEFORE the real receptions line: readMarket keeps
// the first value it sees for a market, so a decoy that appears first is the
// one that lands. (Ordered the other way the bug hides.)
const realPaste = [
  "Tee Higgins",
  "Receiving Yards 69.5",
  "Longest Reception 24.5",
  "Receptions 5.5",
  "Fantasy Points 13.5",
  "Anytime TD +190",
].join("\n");
const roster = [{ id: "h1", name: "Tee Higgins", team: "CIN", pos: "WR" }];
const parsed = parseProps(realPaste, roster);
const higgins = parsed.players[0];
check("props paste matches the player", !!higgins, `matched ${parsed.players.length} players`);
check(
  '"Fantasy Points" is not read as interceptions',
  higgins && higgins.props.ints === undefined,
  `ints = ${higgins && higgins.props.ints}`
);
check(
  '"Longest Reception" does not overwrite the real receptions line',
  higgins && higgins.props.receptions === 5.5,
  `receptions = ${higgins && higgins.props.receptions}`
);
check(
  "a normal paste lands in a sane points range",
  higgins && higgins.computed.points > 10 && higgins.computed.points < 25,
  `computed ${higgins && higgins.computed.points} (was −25.6 with the substring bug)`
);
// …and a genuine interception line must still be read.
const qbPaste = ["Trevor Lawrence", "Passing Yards 245.5", "Interceptions 0.5"].join("\n");
const qbParsed = parseProps(qbPaste, [{ id: "q1", name: "Trevor Lawrence", team: "JAX", pos: "QB" }]);
check(
  "a real interceptions line is still parsed",
  qbParsed.players[0] && qbParsed.players[0].props.ints === 0.5,
  `ints = ${qbParsed.players[0] && qbParsed.players[0].props.ints}`
);

// ---- 10. an explicit ESPN zero is data, not a missing value (finding 11) ----
const zeroSync = applyEspnSync(
  migrate({ v: 2, week: "1", players: {}, lineup: emptyLineup, bench: [null], ir: [null] }),
  {
    currentWeek: 1,
    rosterSlots: { 20: 6, 21: 2 },
    leagueFaab: 100,
    teams: [
      {
        id: 7,
        name: "Test Team",
        faabSpent: 0,
        record: null,
        roster: [{ espnId: "9001", name: "Bye Week Guy", pos: "WR", proTeamId: 12, slot: "BE", injuryStatus: "", percentOwned: 1, proj: 0, actual: null }],
      },
    ],
    matchups: [],
    pool: [],
    games: {},
    impliedTotals: {},
  },
  "Test Team"
);
const zeroId = Object.keys(zeroSync.state.players)[0];
const zeroAnalytics = zeroSync.state.analytics[zeroId]?.["1"];
check(
  "an ESPN projection of 0 is stored, not discarded",
  zeroAnalytics && zeroAnalytics.proj === 0 && zeroAnalytics.projSource === "espn",
  `stored ${JSON.stringify(zeroAnalytics)}`
);
// …and it must beat a stale season average rather than falling back to it.
const zeroState = {
  ...zeroSync.state,
  analytics: { [zeroId]: { 1: { proj: 0, projSource: "espn", seasonAvg: 11.4 } } },
};
const zeroDist = pointDistribution(zeroState.players[zeroId], "1", zeroState);
check(
  "an explicit zero projection beats a stale season average",
  zeroDist && zeroDist.mean === 0,
  `mean = ${zeroDist && zeroDist.mean} (source: ${zeroDist && zeroDist.source})`
);

// ---- 11. a scoring override of exactly 0 must survive (finding 12f) ----
check(
  "a deliberate 0-point override is not treated as absent",
  extractScoring({ scoringSettings: { scoringItems: [{ statId: 53, points: 1, pointsOverrides: { 16: 0 } }] } })
    .reception === 0,
  `reception = ${extractScoring({ scoringSettings: { scoringItems: [{ statId: 53, points: 1, pointsOverrides: { 16: 0 } }] } }).reception}`
);
check(
  "a real override still wins over the base value",
  extractScoring({ scoringSettings: { scoringItems: [{ statId: 4, points: 4, pointsOverrides: { 16: 6 } }] } })
    .passTd === 6
);
check(
  "no override falls back to the base value",
  extractScoring({ scoringSettings: { scoringItems: [{ statId: 4, points: 6, pointsOverrides: {} }] } }).passTd === 6
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll sanity checks passed.");
process.exit(failures ? 1 : 0);
