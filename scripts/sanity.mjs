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
import {
  simulateMatchup,
  simulateSwap,
  simulateLive,
  liveNarrative,
  lineupDistributions,
  sumMeans,
} from "../src/simulate.js";
import { migrate, addCall, callCalibration, applyWin, revertWin } from "../src/lineup.js";
import { applyEspnSync } from "../src/espnSync.js";
import { deriveSchedule } from "../api/schedule.js";
import { gameStatesFrom } from "../api/espn-write.js";
import { storage, probeStorage, STORAGE_MESSAGE } from "../src/storage.js";
import { isAuthorized } from "../api/_auth.js";
import { readFileSync } from "node:fs";
import { currentMatchupPeriod } from "../api/espn.js";

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

// ---- 12. the Lab must not offer illegal swaps (finding 9) ----
const swapState = {
  v: 2,
  week: "1",
  players: {
    qb: { id: "qb", name: "Starting QB", team: "JAX", pos: "QB", ecr: "QB11", status: "" },
    wr: { id: "wr", name: "Bench WR", team: "LAC", pos: "WR", ecr: "WR38", status: "" },
  },
  lineup: { QB: ["qb"], RB: [null, null], WR: [null, null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: ["wr", null, null, null, null, null],
  ir: [null, null],
  byes: {},
  byesAuto: {},
  byesManual: {},
  analytics: { qb: { 1: { proj: 20, projSource: "espn" } }, wr: { 1: { proj: 9, projSource: "espn" } } },
  espn: null,
  ecrIndex: {},
  schedule: null,
  matchups: {},
};
const oppForSwap = [{ name: "them", mean: 20, sd: 7, team: null, opp: null, pos: "QB" }];
const illegal = simulateSwap(swapState, "1", oppForSwap, "qb", "wr");
check(
  "simulateSwap refuses a WR-for-QB swap instead of returning a delta",
  illegal && illegal.illegal === true && typeof illegal.delta !== "number",
  `got ${JSON.stringify(illegal && { illegal: illegal.illegal, delta: illegal.delta })}`
);
// a legal swap must still work
const legalState = {
  ...swapState,
  players: {
    ...swapState.players,
    wr2: { id: "wr2", name: "Starting WR", team: "CIN", pos: "WR", ecr: "WR14", status: "" },
  },
  lineup: { ...swapState.lineup, WR: ["wr2", null, null] },
  analytics: { ...swapState.analytics, wr2: { 1: { proj: 11, projSource: "espn" } } },
};
const legal = simulateSwap(legalState, "1", oppForSwap, "wr2", "wr");
check(
  "a legal same-position swap still returns a delta",
  legal && !legal.illegal && typeof legal.delta === "number",
  `delta = ${legal && legal.delta}`
);

// ---- 13. bye weeks must reach the simulation (finding 10) ----
const byeBase = {
  ...swapState,
  players: {
    a1: { id: "a1", name: "Healthy One", team: "KC", pos: "WR", ecr: "WR10", status: "" },
    a2: { id: "a2", name: "Bye Guy", team: "DEN", pos: "WR", ecr: "WR12", status: "" },
  },
  lineup: { QB: [null], RB: [null, null], WR: ["a1", "a2", null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: [null, null, null, null, null, null],
  analytics: { a1: { 1: { proj: 12, projSource: "espn" } }, a2: { 1: { proj: 12, projSource: "espn" } } },
};
const noBye = lineupDistributions(byeBase, byeBase.lineup, "1");
// the merged effective map is state.byes — Commit 2 split auto/manual beneath it
const withBye = lineupDistributions({ ...byeBase, byes: { DEN: 1 }, byesAuto: { DEN: 1 } }, byeBase.lineup, "1");
check(
  "a player on bye contributes 0 to the simulated total",
  sumMeans(withBye.dists) < sumMeans(noBye.dists) - 11,
  `with bye ${sumMeans(withBye.dists)} vs without ${sumMeans(noBye.dists)}`
);

// ---- 14. an exact tie is not a loss (finding 12c) ----
const finalEntry = (scored) => ({ proj: 0, scored, status: "final", pctRemaining: 0, cv: 0.5, team: null, pos: null, opp: null });
const tied = simulateLive([finalEntry(100)], [finalEntry(100)]);
check(
  "a dead-even final reports a tie, not a loss",
  tied && tied.tieProb > 0.99 && !/lost/i.test(liveNarrative(tied) || ""),
  `tieProb ${tied && tied.tieProb}, narrative: "${liveNarrative(tied)}"`
);

// ---- 15. kickoff locks must fail CLOSED (finding 12h) ----
check(
  "an unreadable scoreboard yields no lock table (refuse the write)",
  gameStatesFrom(null) === null,
  `got ${JSON.stringify(gameStatesFrom(null))}`
);
check(
  "an empty but valid scoreboard is a real empty slate (allow the write)",
  JSON.stringify(gameStatesFrom({ events: [] })) === "{}",
  `got ${JSON.stringify(gameStatesFrom({ events: [] }))}`
);

// ---- 16. addCall keeps the confidence the form collected (finding 12a) ----
const callState = migrate({ v: 2, week: "1", players: {}, lineup: emptyLineup, bench: [null], ir: [null] });
const withCall = addCall(callState, { player: "Bijan Robinson", week: "1", type: "Start", reasoning: "volume", confidence: 5 });
check(
  "addCall persists confidence",
  withCall.state.calls[0].confidence === 5,
  `stored ${JSON.stringify(withCall.state.calls[0].confidence)}`
);
const graded = [
  { ...withCall.state.calls[0], outcome: "right" },
  { id: "legacy", player: "Old Call", type: "Start", outcome: "wrong" }, // pre-fix call, no confidence
];
const calib = callCalibration(graded);
check(
  "callCalibration buckets a high-confidence call as high",
  calib && calib.byConfidence.high && calib.byConfidence.high.n === 1,
  `buckets ${JSON.stringify(calib && calib.byConfidence)}`
);
check(
  "a legacy call with no confidence stays in medium",
  calib && calib.byConfidence.medium && calib.byConfidence.medium.n === 1,
  `buckets ${JSON.stringify(calib && calib.byConfidence)}`
);

// ---- 17. revertWin is the exact inverse of applyWin (finding 12d) ----
const claimState = (faab) => ({
  ...migrate({ v: 2, week: "1", players: {}, lineup: emptyLineup, bench: [null, null], ir: [null] }),
  faab,
});
const roundTrip = (faab, amount) => {
  const before = claimState(faab);
  const claim = { player: "Waiver Add", team: "KC", pos: "WR", amount };
  const applied = applyWin(before, claim);
  if (applied.error) return { ok: false, why: applied.error };
  const reverted = revertWin(applied.state, { ...claim, effects: applied.effects });
  if (reverted.error) return { ok: false, why: reverted.error };
  return {
    ok: reverted.state.faab === before.faab,
    faabBefore: before.faab,
    faabAfter: reverted.state.faab,
    players: Object.keys(reverted.state.players).length,
  };
};
const normalTrip = roundTrip(100, 30);
check("apply→revert restores FAAB (normal case)", normalTrip.ok && normalTrip.players === 0, JSON.stringify(normalTrip));
const clampTrip = roundTrip(10, 30); // bid exceeds balance — the clamping case
check(
  "apply→revert restores FAAB when the bid was clamped",
  clampTrip.ok && clampTrip.players === 0,
  `${JSON.stringify(clampTrip)} (clamping used to invent $20)`
);

// ---- 18. duplicate names must not merge two players (finding 12e) ----
const dupName = (espnId) => ({
  espnId,
  name: "Michael Thomas",
  pos: "WR",
  proTeamId: 12,
  slot: "BE",
  injuryStatus: "",
  percentOwned: 1,
  proj: 6,
  actual: null,
});
const dupStart = migrate({
  v: 2,
  week: "1",
  players: { existing: { id: "existing", name: "Michael Thomas", team: "KC", pos: "WR", espnId: "", ecr: "WR40", notes: "my scouting note" } },
  lineup: emptyLineup,
  bench: ["existing", null, null, null, null, null],
  ir: [null, null],
});
const dupSync = applyEspnSync(
  dupStart,
  {
    currentWeek: 1,
    rosterSlots: { 20: 6, 21: 2 },
    leagueFaab: 100,
    teams: [{ id: 7, name: "Test Team", faabSpent: 0, record: null, roster: [dupName("5001"), dupName("5002")] }],
    matchups: [],
    pool: [],
    games: {},
    impliedTotals: {},
  },
  "Test Team"
);
const seatedIds = [...Object.values(dupSync.state.lineup).flat(), ...dupSync.state.bench, ...dupSync.state.ir].filter(Boolean);
check(
  "two same-named ESPN players become two records, not one",
  Object.keys(dupSync.state.players).length === 2,
  `got ${Object.keys(dupSync.state.players).length} player record(s)`
);
check(
  "both same-named players occupy their own roster spot",
  new Set(seatedIds).size === 2 && seatedIds.length === 2,
  `seated ids ${JSON.stringify(seatedIds)}`
);

// ---- 19. matchups must not silently empty (finding 12g) ----
check(
  "matchup period falls back to the scoring period when status is missing",
  currentMatchupPeriod({ scoringPeriodId: 3 }) === 3,
  `got ${currentMatchupPeriod({ scoringPeriodId: 3 })}`
);
check(
  "an explicit matchup period still wins",
  currentMatchupPeriod({ status: { currentMatchupPeriod: 5 }, scoringPeriodId: 3 }) === 5
);

// ---- 20. the memo-key narrowing must not change the recommendation ----
// LineupCheck now passes a reconstructed { ...state, ...deferredInput } rather
// than `state`. Identical inputs must produce byte-identical output, or the
// speed-up changed the advice.
const scanInput = (s) => ({
  lineup: s.lineup,
  bench: s.bench,
  players: s.players,
  analytics: s.analytics,
  byes: s.byes,
  ecrIndex: s.ecrIndex,
  schedule: s.schedule,
  espn: s.espn,
  matchups: s.matchups,
});
// The bench QB is genuinely better here, so this state DOES yield a move —
// comparing two empty arrays would prove nothing.
const perfState = mkLineupState();
perfState.analytics = { a: { 1: { proj: 12, projSource: "espn" } }, b: { 1: { proj: 25, projSource: "espn" } } };
const fullOut = suggestLineup(perfState, "1", null);
check(
  "the identity fixture actually produces a recommendation",
  fullOut.length === 1 && fullOut[0].inId === "b",
  `moves: ${JSON.stringify(fullOut.map((m) => `${m.inName} over ${m.outName}`))}`
);
const narrowedOut = suggestLineup({ ...perfState, ...scanInput(perfState) }, "1", null);
check(
  "narrowed scan input produces an identical recommendation",
  JSON.stringify(fullOut) === JSON.stringify(narrowedOut),
  `full ${JSON.stringify(fullOut)} vs narrowed ${JSON.stringify(narrowedOut)}`
);
// and with an opponent, where the win-prob scan actually runs
const oppForPerf = [
  { id: "x1", name: "Opp QB", team: "KC", pos: "QB", opp: "BUF", mean: 18, sd: 6 },
  { id: "x2", name: "Opp WR", team: "KC", pos: "WR", opp: "BUF", mean: 13, sd: 7 },
];
check(
  "narrowed scan input is identical in win-probability mode too",
  JSON.stringify(suggestLineup(perfState, "1", oppForPerf)) ===
    JSON.stringify(suggestLineup({ ...perfState, ...scanInput(perfState) }, "1", oppForPerf))
);

// NOTE: the review's proposed debounce for the localStorage write was measured
// and dropped — 0.4ms stringify + 0.1ms setItem on a 66 KB payload is not a
// bottleneck, and debouncing would only add a window to lose a write. There is
// no debounce to assert against; the write stays immediate.

// ---- 21. a failed save must name its own cause ----
// The banner used to say "SAVE ERROR" and swallow the exception, so the
// failure erased the only evidence of why it happened.
const mkErr = (name, message = "") => Object.assign(new Error(message), { name });
const fakeWindow = (impl) => {
  global.window = { localStorage: impl };
  return () => delete global.window;
};

// Safari private browsing: setItem exists, then throws quota with a zero quota,
// so even a one-byte probe fails → "private", not "full".
let restore = fakeWindow({
  setItem() {
    throw mkErr("QuotaExceededError", "The quota has been exceeded.");
  },
  removeItem() {},
  getItem: () => null,
});
let res = await storage.set("k", "v");
check("private browsing is reported as private, not disk-full", res.ok === false && res.reason === "private", `got ${JSON.stringify(res)}`);
check("probeStorage agrees the browser can't store anything", probeStorage().ok === false, JSON.stringify(probeStorage()));
restore();

// Genuinely full: a tiny write succeeds, the real payload doesn't → "full".
let big = true;
restore = fakeWindow({
  setItem(k) {
    if (k === "huddle-probe") return; // small write is fine
    if (big) throw mkErr("QuotaExceededError", "exceeded");
  },
  removeItem() {},
  getItem: () => null,
});
res = await storage.set("huddle-data", "x".repeat(10));
check("a full disk is reported as full, not private", res.ok === false && res.reason === "full", `got ${JSON.stringify(res)}`);
restore();

// Storage switched off for the site.
restore = fakeWindow({
  setItem() {
    throw mkErr("SecurityError", "The operation is insecure.");
  },
  removeItem() {},
  getItem: () => null,
});
res = await storage.set("k", "v");
check("blocked storage is reported as blocked", res.ok === false && res.reason === "blocked", `got ${JSON.stringify(res)}`);
restore();

// Healthy browser.
const store = new Map();
restore = fakeWindow({
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
  getItem: (k) => store.get(k) ?? null,
});
res = await storage.set("huddle-data", "payload");
check("a healthy write reports ok and persists", res.ok === true && store.get("huddle-data") === "payload");
check("probeStorage passes on a healthy browser and cleans up", probeStorage().ok === true && !store.has("huddle-probe"));
restore();

// Every reason must have human-readable copy — a missing key would render blank.
check(
  "every failure reason has a plain-English message",
  ["private", "blocked", "full", "unavailable", "unknown"].every(
    (r) => typeof STORAGE_MESSAGE[r] === "string" && STORAGE_MESSAGE[r].length > 20
  )
);

// ---- 22. the two security controls prose can't defend ----
// Source-text assertions on purpose. The threat here is someone EDITING a
// string — "harmonising" espn.js's cache header with its neighbours, or
// loosening the token gate — so grepping the string matches the threat.
// A comment can't fail a build; this can.
const espnSrc = readFileSync(new URL("../api/espn.js", import.meta.url), "utf8");
check(
  "/api/espn is never shared-cacheable (s-maxage would let the CDN replay an authorized 200)",
  !/s-maxage/.test(espnSrc),
  "found s-maxage in api/espn.js — the token check becomes bypassable at the edge"
);
check(
  "/api/espn still sets an explicit private cache directive",
  /private,\s*max-age=/.test(espnSrc),
  "expected `private, max-age=` in api/espn.js"
);
// The neighbours SHOULD be shared-cacheable — they carry nothing private and
// have no token gate. Asserted so the intent stays legible both ways.
for (const f of ["odds", "schedule", "news"]) {
  check(
    `/api/${f} stays shared-cacheable (no private data, no token gate)`,
    /s-maxage/.test(readFileSync(new URL(`../api/${f}.js`, import.meta.url), "utf8"))
  );
}

// isAuthorized must fail closed. Covered above at the behavioural level; this
// pins the source so the early-return can't be "simplified" away.
const authSrc = readFileSync(new URL("../api/_auth.js", import.meta.url), "utf8");
check(
  "isAuthorized uses a constant-time comparison",
  /timingSafeEqual/.test(authSrc),
  "expected crypto.timingSafeEqual in api/_auth.js"
);
delete process.env.HUDDLE_WRITE_TOKEN;
check(
  "isAuthorized denies everything when HUDDLE_WRITE_TOKEN is unset",
  isAuthorized({ headers: { "x-huddle-token": "anything-at-all" } }) === false
);
process.env.HUDDLE_WRITE_TOKEN = "z".repeat(64);
check(
  "isAuthorized accepts the exact token and rejects a same-length impostor",
  isAuthorized({ headers: { "x-huddle-token": "z".repeat(64) } }) === true &&
    isAuthorized({ headers: { "x-huddle-token": "y".repeat(64) } }) === false
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll sanity checks passed.");
process.exit(failures ? 1 : 0);
