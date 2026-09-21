// Engine + data-integrity sanity checks — run with `npm test`.
// Guards the behaviours the app's honesty depends on:
//   1. scoring uses league values (6-pt pass TDs, rush attempts)
//   2. injury risk is bimodal (Q = 77% × outcome, floor 0)
//   3. correlation: stacked lineups are WIDER, QB-vs-opposing-D/ST narrower
//   4. migrate never silently deletes a player, never double-places one
//   5. ESPN sync seats every player it can and REPORTS the ones it can't
//   6. one failed week fetch must not fabricate a league-wide bye
import fsMod from "node:fs";
import { propsToPoints, SCORING, parseProps } from "../src/props.js";
import { suggestLineup } from "../src/analysis.js";
import { extractScoring, matchupSideScore } from "../api/espn.js";
import { isGameday } from "../api/odds.js";
import { pointDistribution, floorCeiling, fpProjFor, propsSweptFor } from "../src/analytics.js";
import {
  simulateMatchup,
  simulateSwap,
  simulateMatchupLive,
  rowGameState,
  opponentDist,
  simulateLive,
  liveNarrative,
  lineupDistributions,
  sumMeans,
} from "../src/simulate.js";
import { migrate, addCall, callCalibration, applyWin, revertWin, bestLineupFrom, isSeedRoster } from "../src/lineup.js";
import { opponentLineups, opponentDistributions } from "../src/simulate.js";
import { matchPlayer, parseRankings, planEcrUpdates, parseProjections, buildEcrIndex, normKey } from "../src/importer.js";
import { projWeights } from "../src/calibration.js";
import { formatCountdown, untilKick } from "../src/timeUntil.js";
import { anyGameStarted, outcomeTone, outcomeColor } from "../src/headToHead.js";
import { applyEspnSync } from "../src/espnSync.js";
import { deriveSchedule } from "../api/schedule.js";
import { gameStatesFrom } from "../api/espn-write.js";
import { storage, probeStorage, STORAGE_MESSAGE } from "../src/storage.js";
import { isAuthorized } from "../api/_auth.js";
import { readFileSync } from "node:fs";
import { captureCalibration, calibrationStats, calibrationSummary, sourceAccuracy } from "../src/calibration.js";
import { priceBid, demandFactor, weakestReplaceablePoints } from "../src/watchlist.js";
import { liveRankInfo, RANK_SOURCE_LABEL, RANK_SOURCE_SHORT, positionNeedPoints, positionNeeds, dropCandidate } from "../src/analysis.js";
import { currentMatchupPeriod, weeklyProj } from "../api/espn.js";
const weeklyProjBasis = (p, wk) => weeklyProj(p, wk).basis;

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

// ---- 6b. a team rename on ESPN must not kill every future sync ----
// findMyEspnTeam used to match on name alone, so renaming the fantasy team on
// ESPN made applyEspnSync error forever. Once a sync has stored myTeamId that
// id wins; the name is only the bootstrap for the first-ever sync.
const renamed = (name) => {
  const d = mkData({ 20: 7, 21: 2 });
  return { ...d, teams: [{ ...d.teams[0], name }] };
};
check("a completed sync stores the ESPN team id", sync7.state.espn.myTeamId === 7, `stored ${sync7.state.espn.myTeamId}`);
const renamedSync = applyEspnSync(sync7.state, renamed("Some Flashy New Name"), "Test Team");
check(
  "a renamed ESPN team still resolves via the stored id",
  !renamedSync.error && renamedSync.state.espn.myTeamId === 7,
  renamedSync.error || `myTeamId ${renamedSync.state.espn.myTeamId}`
);
check(
  "the sync against the renamed team actually lands",
  seated(renamedSync.state) === 9 && renamedSync.summary.overflow.length === 0,
  `seated ${seated(renamedSync.state)}/9`
);
check(
  "a first-ever sync (no stored id) still requires the name to match",
  !!applyEspnSync(baseState, renamed("Some Flashy New Name"), "Test Team").error
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

// ---- 12b. the Lab must price a FINISHED opponent player at his actual ----
// Live repro: the Lab showed the opponent at 155.5 "ESPN proj" and Kyle at 43%
// — but Stafford (22.2 projected) had finished on 3. ESPN's real total was
// ~127 and Kyle was the FAVOURITE, 149.1 vs 127.1. The Lab ran the PREGAME
// simulator on both sides, so a finished player still contributed a full
// variance distribution around a projection the game had already disproved.
// Gameday got this right through simulateLive; the Lab never reached it.
const labState = {
  ...swapState,
  players: { me: { id: "me", name: "My Guy", team: "KC", pos: "WR", ecr: "WR5", status: "" } },
  lineup: { QB: [null], RB: [null, null], WR: ["me", null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: [null, null, null, null, null, null],
  analytics: { me: { 1: { proj: 20, projSource: "espn" } } },
  matchups: { 1: { oppTeam: "Them" } },
  espn: {
    myTeamId: 7,
    fetchedAt: Date.now(),
    teams: [
      {
        id: 9, name: "Them", mapped: "Them",
        roster: [
          // FINISHED: projected 22.2, actually scored 3. The whole point.
          { name: "Done Guy", team: "DET", pos: "WR", slot: "WR", proj: 22.2, actual: 3, injuryStatus: "ACTIVE" },
          { name: "Later Guy", team: "SF", pos: "WR", slot: "WR", proj: 10, actual: 0, injuryStatus: "ACTIVE" },
        ],
      },
    ],
    games: {
      DET: { state: "post", pctRemaining: 0, detail: "Final" },
      SF: { state: "pre", pctRemaining: 1, detail: "Sun 1:00" },
      KC: { state: "pre", pctRemaining: 1, detail: "Sun 1:00" },
    },
  },
};
const labMine = lineupDistributions(labState, labState.lineup, "1").dists;
const labOpp = opponentDistributions(labState, "1", "Them", "likely");
const labSim = simulateMatchupLive(labState, labMine, labOpp);
check(
  "a finished opponent player is priced at his ACTUAL, not his projection",
  labSim && Math.abs(labSim.oppProjFinal - 13) < 1.5,
  `opponent projected ${labSim && labSim.oppProjFinal}; 3 banked + 10 to come = 13, the pregame sim says ~32`
);
check(
  "and that flips the matchup — 20 vs 13 is a favourite, 20 vs 32 is not",
  labSim && labSim.winProb > 0.5,
  `winProb ${labSim && labSim.winProb}`
);
check(
  "points already banked are reported as banked, not as projection",
  labSim && labSim.oppNow === 3 && labSim.oppLeft === 1,
  JSON.stringify(labSim && { oppNow: labSim.oppNow, oppLeft: labSim.oppLeft })
);
// A finished player is a CONSTANT: zero variance, so repeated runs and a
// different seed cannot move what he contributes.
const labSimB = simulateMatchupLive(labState, labMine, labOpp, 4242);
check(
  "a final score carries no variance — a different seed cannot change it",
  labSimB && labSimB.oppNow === 3 && labSim && labSim.oppNow === 3,
  `seed 12345 banked ${labSim && labSim.oppNow}, seed 4242 banked ${labSimB && labSimB.oppNow}; both must be 3`
);

// ---- 12c. an opponent starter is priced through the SAME blend as my roster ----
// Seen on the Ashton Jeanty card: "Opponent player — ESPN projection. Props,
// matchup and consensus are computed for your roster only." oppDist read
// `e.proj` raw while my own players went through props -> ESPN+FP blend -> FP
// -> ESPN -> season average, plus the implied-total tilt and widen-on-
// disagreement. Two sides of one matchup priced by two different models.
//
// The mirror: identical position, team, ESPN number and pasted FP number, one
// on my roster and one on theirs. They must come out the same.
const a2State = {
  ...swapState,
  week: "1",
  players: { mirror: { id: "mirror", name: "Mirror Guy", team: "KC", pos: "WR", ecr: "WR5", status: "" } },
  lineup: { QB: [null], RB: [null, null], WR: ["mirror", null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: [null, null, null, null, null, null],
  analytics: { mirror: { 1: { proj: 10, projSource: "espn", fpProj: 20 } } },
  matchups: { 1: { oppTeam: "Them" } },
  // The same pasted FantasyPros number, reachable by NAME rather than by a
  // roster id the opponent does not have.
  fpProjIndex: { 1: { oppguy: { proj: 20, stars: null } } },
  espn: {
    myTeamId: 7, fetchedAt: Date.now(),
    teams: [{ id: 9, name: "Them", mapped: "Them", roster: [
      { name: "Opp Guy", team: "KC", pos: "WR", slot: "WR", proj: 10, actual: 0, injuryStatus: "ACTIVE" },
      { name: "Filler Guy", team: "SF", pos: "RB", slot: "RB", proj: 9, actual: 0, injuryStatus: "ACTIVE" },
    ] }],
    games: { KC: { state: "pre", pctRemaining: 1 }, SF: { state: "pre", pctRemaining: 1 } },
  },
};
check(
  "the pasted FantasyPros number is reachable for a player with no roster id",
  fpProjFor(a2State, "1", "Opp Guy")?.proj === 20,
  JSON.stringify(fpProjFor(a2State, "1", "Opp Guy"))
);
const a2Mine = pointDistribution(a2State.players.mirror, "1", a2State);
const a2Opp = opponentDistributions(a2State, "1", "Them", "likely").find((d) => d.name === "Opp Guy");
check(
  "an opponent starter blends ESPN with the pasted expert number, like my own roster does",
  a2Opp && a2Mine && Math.abs(a2Opp.condMean - a2Mine.condMean) < 0.06,
  `opponent ${a2Opp && a2Opp.condMean} vs mine ${a2Mine && a2Mine.condMean}; raw ESPN alone would be 10, the 50/50 blend is 15`
);
check(
  "disagreement widens the opponent too — a contested player is a less certain bet on BOTH sides",
  a2Opp && a2Mine && Math.abs(a2Opp.sd - a2Mine.sd) < 0.06 && a2Opp.sd > 15 * (0.58 * 1.0),
  `opponent sd ${a2Opp && a2Opp.sd} vs mine ${a2Mine && a2Mine.sd}`
);
// An opponent with NO pasted number must be unchanged — this may not quietly
// reprice players the paste never mentioned.
const a2Filler = opponentDistributions(a2State, "1", "Them", "likely").find((d) => d.name === "Filler Guy");
check(
  "an opponent with no pasted number still prices at ESPN's, unchanged",
  a2Filler && Math.abs(a2Filler.condMean - 9) < 0.06,
  `got ${a2Filler && a2Filler.condMean}`
);

// The index has to survive a reload, and must NOT travel in a share snapshot
// — same call as ecrIndex: it is the paste, it is bulky, and it re-pastes.
check(
  "the pasted projection index round-trips through migrate",
  JSON.stringify(migrate({ fpProjIndex: { 1: { x: { proj: 9, stars: 2 } } } }).fpProjIndex) ===
    JSON.stringify({ 1: { x: { proj: 9, stars: 2 } } }) &&
    JSON.stringify(migrate({}).fpProjIndex) === "{}" &&
    JSON.stringify(migrate({ fpProjIndex: "junk" }).fpProjIndex) === "{}",
  JSON.stringify([migrate({}).fpProjIndex, migrate({ fpProjIndex: "junk" }).fpProjIndex])
);

// ---- 12d. every surface that renders a player agrees on his game state ----
// The board could tell you a player was done; the roster screen could not.
// Same player, same week, two screens, and only one of them knew a game had
// been played — so the roster kept showing a projection the game had already
// settled. DESIGN.md's three-state table is approved for anywhere a player
// row renders, not just the paired board.
const a4State = {
  ...swapState,
  week: "1",
  players: {
    done: { id: "done", name: "Done Guy", team: "DET", pos: "WR", ecr: "WR5", status: "" },
    soon: { id: "soon", name: "Soon Guy", team: "SF", pos: "WR", ecr: "WR9", status: "" },
  },
  lineup: { QB: [null], RB: [null, null], WR: ["done", "soon", null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: [null, null, null, null, null, null],
  analytics: { done: { 1: { proj: 22.2, projSource: "espn" } }, soon: { 1: { proj: 14, projSource: "espn" } } },
  espn: {
    myTeamId: 7, fetchedAt: Date.now(),
    teams: [{ id: 7, name: "Brock Hard", mapped: "Brock Hard", roster: [
      { name: "Done Guy", team: "DET", pos: "WR", slot: "WR", proj: 22.2, actual: 3, injuryStatus: "ACTIVE" },
      { name: "Soon Guy", team: "SF", pos: "WR", slot: "WR", proj: 14, actual: 0, injuryStatus: "ACTIVE" },
    ] }],
    games: {
      DET: { state: "post", pctRemaining: 0, detail: "Final" },
      SF: { state: "pre", pctRemaining: 1, detail: "Sun 1:00" },
    },
  },
};
const gsDone = rowGameState(a4State, a4State.players.done, "1", pointDistribution(a4State.players.done, "1", a4State));
const gsSoon = rowGameState(a4State, a4State.players.soon, "1", pointDistribution(a4State.players.soon, "1", a4State));
check(
  "a finished player reads FINAL and shows what he SCORED, not his projection",
  gsDone.isFinal === true && gsDone.chip === "FINAL" && gsDone.value === 3,
  JSON.stringify({ chip: gsDone.chip, value: gsDone.value, isFinal: gsDone.isFinal })
);
check(
  "his track is full once the game is done",
  gsDone.prog === 1,
  `prog ${gsDone.prog}`
);
check(
  "a player who has not kicked off still reads as an estimate",
  gsSoon.isFinal === false && gsSoon.value === 14,
  JSON.stringify({ chip: gsSoon.chip, value: gsSoon.value })
);
// A live player carries BOTH numbers and a direction; nobody else does. The
// headline is what he has BANKED and the projected finish sits under it —
// ESPN's treatment (Kyle, Sept 21). The number he is WORTH to a comparison is
// still the projected finish, which is no longer the number on display.
const a4Live = {
  ...a4State,
  espn: {
    ...a4State.espn,
    games: { ...a4State.espn.games, SF: { state: "in", pctRemaining: 0.25, detail: "Q3 6:14" } },
    teams: [{ ...a4State.espn.teams[0], roster: a4State.espn.teams[0].roster.map((e) =>
      e.name === "Soon Guy" ? { ...e, actual: 9 } : e) }],
  },
};
const gsLive = rowGameState(a4Live, a4Live.players.soon, "1", pointDistribution(a4Live.players.soon, "1", a4Live));
check(
  "a live player leads with points banked, the projected finish beneath, with a direction",
  gsLive.isLive === true && gsLive.chip === "Q3 6:14" && gsLive.value === 9 && gsLive.sub === 12.5 && gsLive.dir === "down",
  JSON.stringify({ chip: gsLive.chip, value: gsLive.value, sub: gsLive.sub, dir: gsLive.dir })
);

// The displayed number and the comparable number have come apart, on purpose:
// a slot comparison that weighed banked points would hand the slot to whoever
// kicked off first.
check(
  "a live player is WORTH his projected finish, not the points on his headline",
  gsLive.worth === 12.5 && gsLive.value === 9,
  JSON.stringify({ worth: gsLive.worth, value: gsLive.value })
);

// A final carries the PREGAME figure beneath, not the live projection — that
// one has collapsed to the actual and would print the headline twice.
check(
  "a finished player carries his pregame projection beneath, and a direction",
  gsDone.sub === 22.2 && gsDone.value === 3 && gsDone.dir === "down",
  JSON.stringify({ value: gsDone.value, sub: gsDone.sub, dir: gsDone.dir })
);

// ...and neither does one who has not kicked off: the projection IS his
// headline, so repeating it underneath would say nothing.
check(
  "a player who has not kicked off carries no second number",
  gsSoon.sub == null,
  `sub ${gsSoon.sub}`
);

// ---- 12e. the league scoreboard mid-week ----
// Every matchup on the Today screen read 0-0 on a Thursday, after games had
// been played. ESPN's mMatchup view only fills totalPoints once it SETTLES
// the matchup period, so mid-week it is genuinely zero — and the strip
// rendered that faithfully. The per-player actuals in the same response were
// correct the whole time, which is why Kyle's own card showed real points
// while the league strip beside it showed nothing.
const b3Team = {
  id: 9,
  roster: [
    { name: "Starter A", slot: "QB", actual: 18.4 },
    { name: "Starter B", slot: "WR", actual: 7.2 },
    { name: "Benched", slot: "BE", actual: 25.0 },
    { name: "Stashed", slot: "IR", actual: 11.1 },
    { name: "Yet to play", slot: "RB", actual: 0 },
  ],
};
check(
  "a mid-week matchup scores from the starters' actuals, not ESPN's unsettled zero",
  matchupSideScore({ teamId: 9, totalPoints: 0 }, b3Team) === 25.6,
  `got ${matchupSideScore({ teamId: 9, totalPoints: 0 }, b3Team)}; 18.4 + 7.2 = 25.6`
);
check(
  "bench and IR points never reach the scoreboard",
  matchupSideScore({ teamId: 9, totalPoints: 0 }, b3Team) === 25.6 &&
    matchupSideScore(
      { teamId: 9, totalPoints: 0 },
      { id: 9, roster: [{ slot: "BE", actual: 25 }, { slot: "IR", actual: 11.1 }, { slot: "QB", actual: 0 }] }
    ) === 0,
  "a team whose only points are on the bench has scored nothing"
);
// Once ESPN settles the period its own number is authoritative and wins —
// it carries stat corrections applied after the fact.
check(
  "a settled week still uses ESPN's own total",
  matchupSideScore({ teamId: 9, totalPoints: 101.6 }, b3Team) === 101.6,
  `got ${matchupSideScore({ teamId: 9, totalPoints: 101.6 }, b3Team)}`
);
check(
  "a genuinely scoreless team reads zero rather than blank",
  matchupSideScore({ teamId: 9, totalPoints: 0 }, { id: 9, roster: [{ slot: "QB", actual: 0 }] }) === 0 &&
    matchupSideScore(null, null) === 0,
  "no roster and no score is still a number"
);

// ---- 12f. the MATCHUP BOARD prices the opponent the same way too ----
// A2 routed oppDist through blendProjection and stopped there. oppDist feeds
// the Start/Sit Lab and the simulator — NOT the Gameday board, which built its
// own opponent rows straight off `e.proj`. So on the one screen Kyle actually
// reads his matchup on, his side ran props -> ESPN+FP blend -> ... and the
// opponent ran raw ESPN. Exactly the asymmetry A2 claimed to close, left open
// on the surface that matters most.
//
// And the other half: props were never priced for the opponent at all, on ANY
// surface. /api/odds already returns every player on the slate with a book
// line — it is fetched and paid for — the client just filtered it to my
// roster. So my side had money-backed lines as the top source and theirs
// could not, however good the paste was.
const a5State = {
  ...swapState,
  week: "1",
  players: { mine: { id: "mine", name: "Mirror Guy", team: "KC", pos: "WR", ecr: "WR5", status: "" } },
  lineup: { QB: [null], RB: [null, null], WR: ["mine", null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: [null, null, null, null, null, null],
  analytics: { mine: { 1: { proj: 10, projSource: "espn", fpProj: 20, propsProj: 17 } } },
  matchups: { 1: { oppTeam: "Them" } },
  fpProjIndex: { 1: { oppguy: { proj: 20, stars: null } } },
  propsIndex: { 1: { oppguy: { proj: 17, parts: ["7.5 rec", "82.5 rec yds"] } } },
  espn: {
    myTeamId: 7, fetchedAt: Date.now(),
    teams: [{ id: 9, name: "Them", mapped: "Them", roster: [
      { name: "Opp Guy", team: "KC", pos: "WR", slot: "WR", proj: 10, actual: 0, injuryStatus: "ACTIVE" },
      { name: "Bare Guy", team: "SF", pos: "RB", slot: "RB", proj: 9, actual: 0, injuryStatus: "ACTIVE" },
    ] }],
    games: { KC: { state: "pre", pctRemaining: 1 }, SF: { state: "pre", pctRemaining: 1 } },
  },
};
const a5Mine = pointDistribution(a5State.players.mine, "1", a5State);
const a5Opp = opponentDist(a5State, "1", a5State.espn.teams[0].roster[0]);
check(
  "a Vegas line prices an opponent exactly as it prices my own player",
  a5Opp && a5Mine && Math.abs(a5Opp.condMean - a5Mine.condMean) < 0.06 && Math.abs(a5Opp.condMean - 17) < 0.06,
  `opponent ${a5Opp && a5Opp.condMean} vs mine ${a5Mine && a5Mine.condMean}; the book says 17`
);
check(
  "props outrank the expert blend on the opponent side too, and say so",
  a5Opp && /props/i.test(a5Opp.source || ""),
  `source "${a5Opp && a5Opp.source}"`
);
check(
  "an opponent with no line and no paste is still exactly ESPN's number",
  (() => {
    const bare = opponentDist(a5State, "1", a5State.espn.teams[0].roster[1]);
    return bare && Math.abs(bare.condMean - 9) < 0.06;
  })(),
  "nobody gets quietly repriced"
);

// ---- 12g. a card must not claim the book has no line when nobody asked ----
// "No book lines for this player this week" is an assertion about the MARKET.
// It was printed whenever propsProj was missing, including when the sweep had
// never run for that week at all — a different fact entirely, and the one that
// is actually true most of the time a card looks empty. Same badge-honesty
// failure as a card reading "no lines pasted" while holding a full set.
//
// propsIndex answers it: a sweep landed for that week, or it did not.
const swept = { propsIndex: { 2: { someguy: { proj: 14, parts: [] } } } };
check(
  "a week with a completed sweep is distinguishable from one without",
  propsSweptFor(swept, "2") === true &&
    propsSweptFor(swept, "3") === false &&
    propsSweptFor({}, "2") === false,
  JSON.stringify([propsSweptFor(swept, "2"), propsSweptFor(swept, "3"), propsSweptFor({}, "2")])
);
// An empty sweep for the week is still a sweep — the market ran and priced
// nobody, which is a real answer and not the same as never asking.
check(
  "an empty sweep still counts as asked",
  propsSweptFor({ propsIndex: { 2: {} } }, "2") === true,
  "the request happened; the book just had nothing"
);

// ---- 12h. sample data must never pass for a real team ----
// A browser profile with no token and no owner link falls back to the seed
// roster — Kyle's real players, frozen at preseason — and the app presented it
// exactly as it presents a live team, down to "YOU'RE SET" on the Today card.
// It cost an hour before anyone thought to doubt the roster itself. The state
// is perfectly detectable; nothing was asking.
check(
  "an untouched seed roster with no sync is identified as sample data",
  isSeedRoster(migrate({})) === true,
  "a fresh device is showing seeds, not a team"
);
check(
  "a synced team is NOT sample data, even though it keeps the seed ids",
  isSeedRoster({ ...migrate({}), espn: { teams: [], games: {}, fetchedAt: Date.now() } }) === false,
  "applyEspnSync preserves ids, so ids alone cannot decide this"
);
check(
  "a roster that has actually changed is NOT sample data",
  (() => {
    const s = migrate({});
    const [firstId] = Object.keys(s.players);
    const players = { ...s.players };
    delete players[firstId];
    return isSeedRoster({ ...s, players }) === false;
  })(),
  "one drop is enough to make it his team rather than the sample"
);

// ---- 12i. the hero flips once points are BANKED, not only while live ----
// The hero already swaps to the current score with the projection beneath it —
// but only while a game is `inProgress`. On a Saturday morning, after Thursday
// night had been played, BennyBalls had 28 real points on the board and the
// hero still showed the projection big with "28 scored" in small grey beneath
// it. Points that are already banked are facts, and a fact outranks a forecast
// whether or not a ball happens to be in the air right now.
const rowWith = (status) => ({ name: "Someone", slot: "WR", l: { status } });
check(
  "a finished game counts as started — the score is banked and real",
  anyGameStarted([rowWith("notStarted"), rowWith("final")]) === true,
  "Thursday night is over; its points are facts"
);
check(
  "a live game still counts as started",
  anyGameStarted([rowWith("inProgress")]) === true
);
check(
  "nothing kicked off yet is NOT started — pre-kickoff the score is noise",
  anyGameStarted([rowWith("notStarted"), rowWith("notStarted")]) === false &&
    anyGameStarted([]) === false,
  "everyone is on zero and the projection is the story"
);
check(
  "an empty slot cannot make a matchup look started",
  anyGameStarted([{ name: null, l: { status: "final" } }]) === false,
  "an unfilled roster spot has no game"
);

// ---- 12j. the hero totals carry the outcome, at a temperature ----
// Kyle's spec: projected winner green, projected loser red, and the INTENSITY
// says how solid it is — bright green for a lock, pale for barely ahead.
//
// This deliberately unlocks DESIGN.md rule 2 ("gold is you, slate is them;
// green is banned from this role"). That rule exists because green reads as
// "good" and, on a win bar, pointed at whoever happened to be favoured. Kyle
// asked for it twice knowing that, so the rule is amended rather than quietly
// contradicted — and rule 3 still holds: "You 32% / Him 68%" sits under the
// numbers, so the colour is never the only channel.
check(
  "a coin flip is neutral on BOTH sides — nobody is coloured as a winner",
  outcomeTone(0.5, true)?.heat === 0 && outcomeTone(0.5, false)?.heat === 0,
  JSON.stringify([outcomeTone(0.5, true), outcomeTone(0.5, false)])
);
check(
  "the two sides always run at the same temperature, opposite signs",
  (() => {
    const mine = outcomeTone(0.82, true);
    const theirs = outcomeTone(0.82, false);
    return mine?.winning === true && theirs?.winning === false && Math.abs((mine?.heat ?? 0) - (theirs?.heat ?? 1)) < 1e-9;
  })(),
  JSON.stringify([outcomeTone(0.82, true), outcomeTone(0.82, false)])
);
check(
  "heat rises with certainty, not with the lead",
  (outcomeTone(0.55, true)?.heat ?? 1) < (outcomeTone(0.75, true)?.heat ?? 0) &&
    (outcomeTone(0.75, true)?.heat ?? 1) < (outcomeTone(0.99, true)?.heat ?? 0),
  JSON.stringify([0.55, 0.75, 0.99].map((p) => outcomeTone(p, true)?.heat ?? null))
);
check(
  "a near-lock is a brighter green than a narrow lead",
  (() => {
    const barely = outcomeColor(0.55, true);
    const lock = outcomeColor(0.99, true);
    if (!barely || !lock) return false;
    const lum = (hex) => parseInt(hex.slice(3, 5), 16); // green channel
    return lum(lock) > lum(barely);
  })(),
  `${outcomeColor(0.55, true)} -> ${outcomeColor(0.99, true)}`
);
check(
  "losing is red on whichever side is losing, mine included",
  (() => {
    const meLosing = outcomeColor(0.2, true);
    const themLosing = outcomeColor(0.8, false);
    if (!meLosing || !themLosing) return false;
    const red = (hex) => parseInt(hex.slice(1, 3), 16);
    const grn = (hex) => parseInt(hex.slice(3, 5), 16);
    return red(meLosing) > grn(meLosing) && red(themLosing) > grn(themLosing);
  })(),
  `${outcomeColor(0.2, true)} / ${outcomeColor(0.8, false)}`
);
check(
  "no win probability yet means no colour claim at all",
  outcomeTone(null, true) === null && outcomeColor(undefined, true) === null,
  "pre-sim there is nothing to say"
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

// ---- 23. calibration ledger: refresh before kickoff, freeze at it ----
// The freeze is the whole point. Letting a projection update after kickoff
// would grade the model against a number it revised with hindsight.
const calPlayer = { id: "c1", name: "Ledger Guy", team: "KC", pos: "WR", espnId: "7001", status: "" };
const calState = (proj, gameState, actual) => ({
  week: "1",
  players: { c1: calPlayer },
  analytics: { c1: { 1: { proj, projSource: "espn" } } },
  byes: {},
  calibration: {},
  espn: {
    myTeamId: 7,
    games: { KC: { state: gameState } },
    teams: [
      {
        id: 7,
        roster: [{ espnId: "7001", name: "Ledger Guy", pos: "WR", team: "KC", slot: "WR", proj, actual }],
      },
    ],
  },
});

// pre-kickoff: projection tracks the latest number
let s1 = calState(11, "pre", null);
let r1 = captureCalibration(s1, "1");
check("pre-kickoff projection is captured", r1.calibration["1"].c1.proj === 11, JSON.stringify(r1.calibration["1"].c1));
check("pre-kickoff row is not locked", r1.calibration["1"].c1.locked === false);

// still pre-kickoff, better number arrives (props post) → it updates
let s2 = { ...calState(14, "pre", null), calibration: r1.calibration };
let r2 = captureCalibration(s2, "1");
check("projection keeps refreshing until kickoff", r2.calibration["1"].c1.proj === 14, `got ${r2.calibration["1"].c1.proj}`);

// kickoff → freeze
let s3 = { ...calState(14, "in", null), calibration: r2.calibration };
let r3 = captureCalibration(s3, "1");
check("kickoff locks the row", r3.calibration["1"].c1.locked === true);

// a later (hindsight-tainted) projection must NOT overwrite the frozen one
let s4 = { ...calState(3, "in", null), calibration: r3.calibration };
let r4 = captureCalibration(s4, "1");
check(
  "a post-kickoff projection change cannot rewrite history",
  r4.calibration["1"].c1.proj === 14,
  `got ${r4.calibration["1"].c1.proj} — hindsight leaked into the ledger`
);

// final → grade against the frozen projection
let s5 = { ...calState(3, "post", 22.4), calibration: r4.calibration };
let r5 = captureCalibration(s5, "1");
const row = r5.calibration["1"].c1;
check("final records the actual", row.actual === 22.4 && r5.graded === 1, JSON.stringify(row));
check("the graded pair is the frozen projection, not the late one", row.proj === 14 && row.actual === 22.4);

// ---- 23b. the freeze needs a pregame number to freeze ----
// Locking used to mean "recompute at the first sync on or after kickoff and
// stamp it locked". Both of these are that hole: the number it stamps was
// computed with the game already in progress.

// (a) a sync that lands AT kickoff must lock what was captured before it, not
//     re-read the projection — which by then may already reflect the game.
let sLock = { ...calState(3, "in", null), calibration: r2.calibration };
let rLock = captureCalibration(sLock, "1");
check(
  "locking freezes the pregame number, it does not recompute at kickoff",
  rLock.calibration["1"].c1.proj === 14,
  `got ${rLock.calibration["1"].c1.proj} — the number was re-read after kickoff`
);

// (b) nobody opened the app until Sunday afternoon: there is no pregame number
//     for this player at all, so there is nothing honest to grade.
let sLate = calState(9, "in", null);
let rLate = captureCalibration(sLate, "1");
check(
  "a first sync after kickoff records no projection",
  rLate.calibration["1"].c1 === undefined && rLate.missed === 1 && rLate.captured === 0,
  JSON.stringify({ row: rLate.calibration["1"].c1, missed: rLate.missed, captured: rLate.captured })
);

// ...and the actual must not be recorded either: an actual with no projection
// to grade it against is not a data point, it is a number with no question.
let sLateFinal = { ...calState(9, "post", 18.2), calibration: rLate.calibration };
let rLateFinal = captureCalibration(sLateFinal, "1");
check(
  "an ungraded-because-late player records no actual either",
  rLateFinal.calibration["1"].c1 === undefined && rLateFinal.graded === 0,
  JSON.stringify({ row: rLateFinal.calibration["1"].c1, graded: rLateFinal.graded })
);

// ---- 23c. props are GRADED, not just stored ----
// analytics.js lets props REPLACE the expert blend outright. sources.props has
// been stored since week 1 and nothing read it back, so the strongest
// assumption in the projection path was the one never checked.
const accRows = (n, propsErr, blendErr) => {
  const rows = {};
  for (let i = 0; i < n; i++) {
    rows[`p${i}`] = {
      actual: 10,
      sources: { espn: 10 + blendErr, fp: 10 + blendErr, props: 10 + propsErr },
      proj: 10,
    };
  }
  return { calibration: { 1: rows }, projWeights: { espn: 0.5, fp: 0.5, basis: "assumed" } };
};
check(
  "thin data reports coverage, never a verdict",
  sourceAccuracy(accRows(5, 1, 4)).basis === "thin" && sourceAccuracy(accRows(5, 1, 4)).n === 5,
  JSON.stringify(sourceAccuracy(accRows(5, 1, 4)))
);
const accProps = sourceAccuracy(accRows(25, 1, 4));
check(
  "props ahead of the blend is measured and named",
  accProps.basis === "measured" && accProps.props === 1 && accProps.blend === 4 && accProps.lead === "props",
  JSON.stringify(accProps)
);
const accBlend = sourceAccuracy(accRows(25, 5, 2));
check(
  "the blend ahead of props is reported too — the precedence can be wrong",
  accBlend.lead === "blend" && accBlend.props === 5 && accBlend.blend === 2,
  JSON.stringify(accBlend)
);
check(
  "a tenth of a point apart is a tie, not a finding",
  sourceAccuracy(accRows(25, 2, 2.05)).lead === "tie",
  JSON.stringify(sourceAccuracy(accRows(25, 2, 2.05)))
);
// A row missing any one source cannot be compared, so it is not counted.
check(
  "rows without all three sources are excluded from the comparison",
  sourceAccuracy({
    calibration: { 1: { a: { actual: 10, sources: { espn: 9, fp: 9 } } } },
  }).n === 0
);

// preseason / non-numeric weeks aren't gradeable
check(
  "a non-numeric week captures nothing",
  captureCalibration({ ...calState(11, "pre", null), week: "PRE" }, "PRE").captured === 0
);

// stats + the deliberate refusal to judge on thin data
const stats = calibrationStats(r5);
check("stats count tracked and graded rows", stats.tracked === 1 && stats.graded === 1, JSON.stringify(stats));
check(
  "no verdict is published below the sample threshold",
  calibrationSummary(r5) === null,
  "a hit-rate off one game is exactly the overconfidence this ledger exists to catch"
);

// ---- 24. bids are priced in points and gated by real demand ----
// The bug: 3 + upgradeRanks*1.2 + rivals*6 priced a 1%-rostered player at $23.
const bidBase = { pointsAdded: 34, rivals: 1, week: "1", faab: 99 };
const cheap = priceBid({ ...bidBase, owned: 3 });
check(
  "a 3%-rostered modest upgrade is a SINGLE-DIGIT bid",
  cheap.bid < 10,
  `got $${cheap.bid} — the old formula said $23 for this`
);
const contested = priceBid({ ...bidBase, owned: 55 });
check(
  "the same player at 55% rostered costs materially more",
  contested.bid > cheap.bid * 2.5,
  `3% → $${cheap.bid}, 55% → $${contested.bid}`
);
check(
  "a player who adds nothing gets the minimum bid regardless of rank delta",
  priceBid({ pointsAdded: 0, owned: 70, rivals: 4, week: "5", faab: 99 }).bid === 1,
  `got $${priceBid({ pointsAdded: 0, owned: 70, rivals: 4, week: "5", faab: 99 }).bid}`
);
const wk2 = priceBid({ ...bidBase, owned: 50, week: "2" });
const wk11 = priceBid({ ...bidBase, owned: 50, week: "11" });
check(
  "late-season FAAB is spent more freely than early-season FAAB",
  wk11.bid > wk2.bid,
  `wk2 $${wk2.bid} vs wk11 $${wk11.bid} — early budget buys optionality, late budget expires`
);
check(
  "a bid never exceeds remaining FAAB",
  priceBid({ pointsAdded: 500, owned: 95, rivals: 4, week: "12", faab: 6 }).bid <= 6,
  `got $${priceBid({ pointsAdded: 500, owned: 95, rivals: 4, week: "12", faab: 6 }).bid} of $6 left`
);
check("a bid never goes below 1", priceBid({ pointsAdded: 0, owned: 0, week: "1", faab: 99 }).bid >= 1);
// thinness scales, it no longer manufactures
check(
  "positional thinness scales a contested bid but can't create one from nothing",
  priceBid({ pointsAdded: 0, owned: 5, rivals: 4, week: "3", faab: 99 }).bid === 1 &&
    priceBid({ ...bidBase, owned: 55, rivals: 4 }).bid > priceBid({ ...bidBase, owned: 55, rivals: 0 }).bid
);
check(
  "the handcuff branch is priced and labelled as a heuristic",
  priceBid({ ...bidBase, owned: 20, handcuffFor: "Bijan Robinson" }).bid >
    priceBid({ ...bidBase, owned: 20 }).bid &&
    priceBid({ ...bidBase, owned: 20, handcuffFor: "Bijan Robinson" }).why.some((w) => /heuristic/i.test(w))
);
check(
  "unknown ownership is priced conservatively, not free",
  demandFactor(null) > demandFactor(3) && demandFactor(null) < demandFactor(55),
  `null=${demandFactor(null).toFixed(2)} vs 3%=${demandFactor(3).toFixed(2)} vs 55%=${demandFactor(55).toFixed(2)}`
);

// an empty starting slot means replacement level is zero
const emptySlotState = {
  week: "1",
  players: { w1: { id: "w1", name: "Only WR", team: "KC", pos: "WR", status: "" } },
  lineup: { QB: [null], RB: [null, null], WR: ["w1", null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  analytics: { w1: { 1: { proj: 12, projSource: "espn" } } },
  byes: {},
  espn: null,
};
check(
  "an empty startable slot prices replacement at zero, not at your worst starter",
  weakestReplaceablePoints(emptySlotState, "1", "WR") === 0,
  `got ${weakestReplaceablePoints(emptySlotState, "1", "WR")}`
);

// ---- 25. ranks carry their provenance ----
const rankState = {
  ecrIndex: { pastedguy: 8 },
  espn: { autoRanks: { pastedguy: 40, projguy: 22 } },
};
check(
  "a pasted expert rank is labelled as consensus and wins over the projection",
  JSON.stringify(liveRankInfo(rankState, { name: "Pasted Guy" })) === JSON.stringify({ rank: 8, source: "fp" })
);
check(
  "a projection-derived rank is labelled ESPN, not consensus",
  JSON.stringify(liveRankInfo(rankState, { name: "Proj Guy" })) === JSON.stringify({ rank: 22, source: "espn" })
);
check(
  "a seed ECR string is labelled preseason ECR",
  JSON.stringify(liveRankInfo(rankState, { name: "Nobody Known", ecr: "WR31" })) ===
    JSON.stringify({ rank: 31, source: "ecr" })
);
check("an unrankable player returns null rather than a bare number", liveRankInfo(rankState, { name: "Ghost" }) === null);
check(
  "every source has a human label",
  ["espn", "fp", "ecr"].every((s) => RANK_SOURCE_LABEL[s] && RANK_SOURCE_SHORT[s])
);

// ---- 26. opponent lineup realism ----
// The app used to simulate against whatever slots the opponent happened to
// have set — a stale OUT player included — so every win probability was
// computed against a lineup its owner would obviously fix before kickoff.
const oppEntry = (name, pos, slot, proj, injuryStatus = "", team = "KC") => ({
  name,
  pos,
  slot,
  proj,
  actual: null,
  espnId: name.replace(/\W/g, ""),
  injuryStatus,
  team,
  percentOwned: 50,
});
const mkOppState = (games = {}) => ({
  week: "1",
  matchups: { 1: { oppTeam: "Rivals" } },
  schedule: null,
  players: {},
  lineup: {},
  ecrIndex: {},
  espn: {
    myTeamId: 1,
    games,
    teams: [
      {
        id: 2,
        name: "Rivals",
        mapped: "Rivals",
        roster: [
          oppEntry("Opp QB", "QB", "QB", 18),
          oppEntry("Hurt Starter", "WR", "WR", 11, "OUT"),
          oppEntry("Fine WR", "WR", "WR", 12),
          oppEntry("Third WR", "WR", "WR", 9),
          oppEntry("Opp TE", "TE", "TE", 8),
          oppEntry("Opp RB1", "RB", "RB", 14),
          oppEntry("Opp RB2", "RB", "RB", 10),
          oppEntry("Opp FLEX", "RB", "FLEX", 9),
          oppEntry("Opp DST", "D/ST", "D/ST", 7),
          oppEntry("Opp K", "K", "K", 8),
          // on their bench and clearly better than the OUT starter
          oppEntry("Benched Stud", "WR", "BE", 15),
        ],
      },
    ],
  },
});

const both = opponentLineups(mkOppState(), "1", "Rivals");
const nameOf = (ds) => ds.map((d) => d.name).sort();
check("opponent lineups are reported both ways", !!both && both.differs === true, JSON.stringify(both && both.differs));
check(
  "the OUT player is in their ACTUAL lineup",
  nameOf(both.actual).includes("Hurt Starter"),
  JSON.stringify(nameOf(both.actual))
);
check(
  "the OUT player is NOT in their likely lineup — the bench stud starts instead",
  !nameOf(both.likely).includes("Hurt Starter") && nameOf(both.likely).includes("Benched Stud"),
  JSON.stringify(nameOf(both.likely))
);
check(
  "the swap they'd make is named, so the UI can explain it",
  both.changes.some((c) => c.out && c.out.name === "Hurt Starter"),
  JSON.stringify(both.changes.map((c) => [c.out && c.out.name, c.in && c.in.name]))
);
// an OUT player scores 0, so removing him RAISES their expected total
check(
  "their likely lineup outscores the one they have set",
  sumMeans(both.likely) > sumMeans(both.actual),
  `likely ${sumMeans(both.likely)} vs actual ${sumMeans(both.actual)}`
);

// once a game kicks off, that slot can't change — the two lineups converge
const locked = opponentLineups(mkOppState({ KC: { state: "in" } }), "1", "Rivals");
check(
  "a kicked-off slot is pinned to reality, not optimized away",
  nameOf(locked.likely).includes("Hurt Starter") && locked.anyLocked === true,
  `likely ${JSON.stringify(nameOf(locked.likely))}, anyLocked ${locked.anyLocked}`
);

// and the default the app simulates against is the LIKELY one
check(
  "opponentDistributions defaults to the likely lineup",
  !opponentDistributions(mkOppState(), "1", "Rivals").some((d) => d.name === "Hurt Starter")
);
check(
  "…but the actual lineup is still available on request",
  opponentDistributions(mkOppState(), "1", "Rivals", "actual").some((d) => d.name === "Hurt Starter")
);

// the shared primitive really is shared
const picked = bestLineupFrom([
  { id: "a", pos: "QB", score: 10 },
  { id: "b", pos: "QB", score: 25 },
  { id: "c", pos: "WR", score: 12 },
]);
check(
  "bestLineupFrom takes the better QB and fills what it can",
  picked.bySlot["QB:0"] === "b" && picked.starterIds.has("c"),
  JSON.stringify(picked.bySlot)
);
check(
  "bestLineupFrom honours pinned slots",
  bestLineupFrom(
    [
      { id: "a", pos: "QB", score: 10 },
      { id: "b", pos: "QB", score: 25 },
    ],
    { "QB:0": "a" }
  ).bySlot["QB:0"] === "a"
);

// ---- 27. the importer matcher, against the real roster's collisions ----
// Five of sixteen failed before this: FantasyPros abbreviates first names on
// its position pages, and this roster contains TWO surname+initial collisions
// (Bijan/Brian Robinson, Jameson/Javonte Williams) plus a D/ST written by
// nickname. The team abbreviation in the same row resolves all of them — it
// was parsed and then thrown away.
const rosterFixture = [
  ["Bijan Robinson", "ATL", "RB"],
  ["Brian Robinson Jr.", "SF", "RB"],
  ["Jameson Williams", "DET", "WR"],
  ["Javonte Williams", "DAL", "RB"],
  ["Steelers D/ST", "PIT", "D/ST"],
  ["Trevor Lawrence", "JAX", "QB"],
].map(([name, team, pos], i) => ({ id: `r${i}`, name, team, pos, ecr: "" }));

const m = (name, hints) => matchPlayer(name, rosterFixture, hints);
check(
  "an abbreviated name + team resolves a same-surname collision",
  m("B. Robinson", { team: "ATL", pos: "RB" }).match?.name === "Bijan Robinson" &&
    m("B. Robinson", { team: "SF", pos: "RB" }).match?.name === "Brian Robinson Jr.",
  `ATL → ${m("B. Robinson", { team: "ATL" }).match?.name}, SF → ${m("B. Robinson", { team: "SF" }).match?.name}`
);
check(
  "position breaks a collision when the teams don't",
  m("J. Williams", { pos: "WR" }).match?.name === "Jameson Williams" &&
    m("J. Williams", { pos: "RB" }).match?.name === "Javonte Williams"
);
check(
  "an abbreviated name with NO hints is still reported ambiguous, not guessed",
  m("B. Robinson", {}).ambiguous === true && m("B. Robinson", {}).match === null
);
check(
  "a D/ST written by nickname alone matches on team",
  m("Steelers", { team: "PIT" }).match?.name === "Steelers D/ST",
  `got ${m("Steelers", { team: "PIT" }).match?.name}`
);
check(
  "a D/ST matches by nickname even with no team hint",
  m("Steelers", {}).match?.name === "Steelers D/ST" &&
    m("Steelers D/ST", { pos: "D/ST" }).match?.name === "Steelers D/ST"
);
check(
  "a stale team on our side doesn't turn a findable match into a miss",
  // row says he's on KC; our roster still has him on JAX. Name is unique, so
  // the team filter must not be allowed to empty the candidate set.
  m("T. Lawrence", { team: "KC", pos: "QB" }).match?.name === "Trevor Lawrence"
);
// end to end through the real parser
const parsed16 = parseRankings(
  ["1 B. Robinson ATL", "2 B. Robinson SF", "3 J. Williams DET", "4 J. Williams DAL", "5 Steelers PIT"].join("\n")
);
const plan16 = planEcrUpdates(parsed16.rows, rosterFixture);
check(
  "a full abbreviated ranking paste matches every colliding player",
  plan16.updates.length === 5 && plan16.ambiguous.length === 0 && plan16.unmatched.length === 0,
  `matched ${plan16.updates.length}/5, ambiguous ${plan16.ambiguous.length}, unmatched ${plan16.unmatched.length}`
);

// ---- 27b. a weekly ranking paste REPLACES last week's rank, never ratchets ----
// buildEcrIndex used to keep the LOWEST rank it had ever seen for a name.
// That is right within one week's paste and wrong across weeks: a WR who
// falls from 12 to 40 stayed indexed at 12 forever, and no UI clears the
// index. It is not a cosmetic number — ecrIndex outranks ESPN's live
// autoRanks in liveRankInfo and drives the opponent sim through
// rankToPoints, so a stale 12 is a number the app acts on.
const hk = normKey("Tee Higgins");
const wk1Index = buildEcrIndex(parseRankings("12. Tee Higgins WR - CIN").rows, {});
const wk2Index = buildEcrIndex(parseRankings("40. Tee Higgins WR - CIN").rows, wk1Index);
check("week 1's paste indexes the rank it was given", wk1Index[hk] === 12, `got ${wk1Index[hk]}`);
check(
  "week 2's paste REPLACES that rank even though it is worse",
  wk2Index[hk] === 40,
  `got ${wk2Index[hk]} — a ratcheting index keeps week 1's 12 forever`
);
// The other half of the contract, and the reason the fix is in the merge
// rather than at the call site: FantasyPros publishes one page per position
// and the panel has a position selector for exactly that, so the weekly
// import is several pastes in a row. A paste must not wipe the players it
// never mentions.
const plusQb = buildEcrIndex(parseRankings("3. Trevor Lawrence QB - JAX").rows, wk2Index);
check(
  "a later paste leaves players it doesn't mention alone",
  plusQb[normKey("Trevor Lawrence")] === 3 && plusQb[hk] === 40,
  JSON.stringify(plusQb)
);

// The stamp that makes the replace visible: which week's paste the index
// currently reflects. It has to survive a reload, and a junk value must not
// render as a week.
check(
  "the ranks-imported week round-trips through migrate",
  migrate({ ecrWeek: "3" }).ecrWeek === "3" && migrate({}).ecrWeek === null && migrate({ ecrWeek: "99" }).ecrWeek === null,
  JSON.stringify([migrate({ ecrWeek: "3" }).ecrWeek, migrate({}).ecrWeek, migrate({ ecrWeek: "99" }).ecrWeek])
);

// ---- 27c. the D/ST last resort must not steal a row that names someone else ----
// Live repro: "26 QB Aaron Rodgers PIT" was written onto Steelers D/ST —
// ECR QB26 and a 15.1 projection on a defense that projects 8.2 — because the
// last-resort defense match fires on team alone and ignored both the declared
// position and the fact that "Aaron Rodgers" is a person. The genuine DST row
// was then swallowed by the `claimed` guard, so the preview reported a clean
// match while a row silently vanished.
const stealRoster = [
  { id: "d1", name: "Steelers D/ST", team: "PIT", pos: "D/ST", ecr: "" },
  { id: "r1", name: "Chase Brown", team: "CIN", pos: "RB", ecr: "" },
];
const stealRows = parseRankings("26. Aaron Rodgers QB - PIT\n3. Steelers DST - PIT").rows;
const stealPlan = planEcrUpdates(stealRows, stealRoster);
const dstUpdate = stealPlan.updates.find((u) => u.id === "d1");
check(
  "a QB row is not written onto a same-team D/ST",
  dstUpdate && dstUpdate.to === "DST3",
  `D/ST got ${dstUpdate ? dstUpdate.to : "no update at all"}`
);
check(
  "the unrostered QB lands in unmatched rather than nowhere",
  stealPlan.unmatched.some((r) => /Rodgers/.test(r.name)),
  `unmatched: ${JSON.stringify(stealPlan.unmatched.map((r) => r.name))}`
);

// The same steal through the projections CSV, which is where it was measured.
// This export shape carries NO position column, so a positional gate cannot
// fire here — the defense has to refuse a two-token personal name on a team
// match alone. Both halves are needed; neither covers the other's path.
const stealCsv = [
  '"RK","PLAYER NAME","TEAM","OPP","MATCHUP","PROJ. FPTS"',
  '26,"Aaron Rodgers","PIT","@CLE","3 out of 5 stars",15.1',
  '3,"Steelers","PIT","@CLE","4 out of 5 stars",8.2',
].join("\n");
const stealProj = parseProjections(stealCsv, stealRoster);
const dstProj = stealProj.matched.find((m) => m.player.id === "d1");
check(
  "a D/ST keeps its own projection, not the QB's",
  dstProj && dstProj.proj === 8.2,
  `D/ST projected ${dstProj ? dstProj.proj : "nothing"}; the QB row was 15.1`
);
check(
  "a two-token personal name is never handed to a defense on team alone",
  stealProj.unmatched.some((r) => /Rodgers/.test(r.name)),
  `unmatched: ${JSON.stringify(stealProj.unmatched.map((r) => r.name))}`
);
// The nickname forms that MUST keep working — this is the match the last
// resort exists for, and the gate must not cost them.
check(
  "a bare nickname still reaches the defense, with and without a team hint",
  matchPlayer("Steelers", stealRoster, { team: "PIT" }).match?.id === "d1" &&
    matchPlayer("Steelers", stealRoster, {}).match?.id === "d1" &&
    matchPlayer("Pittsburgh Steelers", stealRoster, {}).match?.id === "d1",
  JSON.stringify([
    matchPlayer("Steelers", stealRoster, { team: "PIT" }).match?.name,
    matchPlayer("Steelers", stealRoster, {}).match?.name,
    matchPlayer("Pittsburgh Steelers", stealRoster, {}).match?.name,
  ])
);

// ---- 27d. every parsed row lands in exactly one bucket ----
// The second half of the same defect: a row matching an already-claimed
// player hit a bare `continue` and was counted nowhere, so a paste could
// report "N parsed / M matched" with the arithmetic quietly not closing.
// A shortfall has to be visible, whatever caused it.
const dupRoster = [{ id: "c1", name: "Chase Brown", team: "CIN", pos: "RB", ecr: "" }];
const dupRows = parseRankings(["4. Chase Brown RB - CIN", "9. Chase Brown RB - CIN"].join("\n")).rows;
const dupPlan = planEcrUpdates(dupRows, dupRoster);
check(
  "a second row for an already-claimed player is reported as a duplicate",
  (dupPlan.duplicate || []).length === 1 && (dupPlan.duplicate || [])[0]?.rank === 9,
  JSON.stringify(dupPlan.duplicate ?? null)
);
check(
  "rankings rows account for themselves: updates + unchanged + duplicate + unmatched + ambiguous",
  dupPlan.updates.length + (dupPlan.unchanged || []).length + (dupPlan.duplicate || []).length +
    dupPlan.unmatched.length + dupPlan.ambiguous.length === dupRows.length,
  JSON.stringify({
    rows: dupRows.length, updates: dupPlan.updates.length, unchanged: (dupPlan.unchanged || []).length,
    duplicate: (dupPlan.duplicate || []).length, unmatched: dupPlan.unmatched.length, ambiguous: dupPlan.ambiguous.length,
  })
);
// A row that matches but changes nothing is also a row, and was equally
// invisible — this is the "already applied" case the panel talks about.
const sameRows = parseRankings("4. Chase Brown RB - CIN").rows;
const samePlan = planEcrUpdates(sameRows, [{ ...dupRoster[0], ecr: "RB4" }]);
check(
  "a row that matches but changes nothing is counted, not dropped",
  samePlan.updates.length === 0 && (samePlan.unchanged || []).length === 1,
  JSON.stringify({ updates: samePlan.updates.length, unchanged: (samePlan.unchanged || []).length })
);

// Caught by a screenshot, not by the assertions above: a row that matched but
// changed nothing did not CLAIM the player, so a later row for the same player
// still won. "First rank wins" was therefore false exactly when the first rank
// was already applied — and the duplicate warning says first-wins on screen.
// Claiming on every match, the way the projections path already does, is what
// makes that sentence true.
const noopFirst = parseRankings(["14. Tee Higgins WR - CIN", "50. Tee Higgins WR - CIN"].join("\n")).rows;
const noopPlan = planEcrUpdates(noopFirst, [{ id: "h1", name: "Tee Higgins", team: "CIN", pos: "WR", ecr: "WR14" }]);
check(
  "a matched row claims its player even when it changes nothing, so first really does win",
  noopPlan.updates.length === 0 &&
    (noopPlan.unchanged || []).length === 1 &&
    (noopPlan.duplicate || []).length === 1,
  JSON.stringify({
    updates: noopPlan.updates.map((u) => u.to),
    unchanged: (noopPlan.unchanged || []).length,
    duplicate: (noopPlan.duplicate || []).length,
  })
);

const dupProj = parseProjections(
  ['"RK","PLAYER NAME","TEAM","OPP","MATCHUP","PROJ. FPTS"',
   '4,"Chase Brown","CIN","@CLE","3 out of 5 stars",17.6',
   '9,"Chase Brown","CIN","@CLE","3 out of 5 stars",11.2'].join("\n"),
  dupRoster
);
check(
  "projection rows account for themselves too",
  (dupProj.duplicate || []).length === 1 &&
    dupProj.matched.length + (dupProj.duplicate || []).length + dupProj.unmatched.length +
      dupProj.ambiguous.length === dupProj.rows.length,
  JSON.stringify({
    rows: dupProj.rows.length, matched: dupProj.matched.length, duplicate: (dupProj.duplicate || []).length,
    unmatched: dupProj.unmatched.length, ambiguous: dupProj.ambiguous.length,
  })
);
check(
  "the first value wins, so a duplicate never overwrites what already matched",
  dupProj.matched[0]?.proj === 17.6,
  `got ${dupProj.matched[0]?.proj}`
);

// ---- 27e. the HEADERLESS FantasyPros export ----
// Kyle's actual Week 2 paste. FantasyPros exports comma-separated with NO
// header row:
//   rank, POS, name, team, opp, "N out of 5 stars", grade, proj, diff, start%
// parseProjections handled a CSV WITH a header, or whitespace-separated text,
// and this shape is neither — so it fell through to the free-form path, which
// takes "the last number on the line" as the projection. On his real file that
// is the denominator of the start% column: Trey McBride came through as 16
// instead of 15.5, Cameron Dicker as 16 instead of 9.1, and every name arrived
// as "1, ,Trey McBride,ARI, , ,A+,15.5,..." so nothing matched his roster.
//
// Silent and expensive: 169 rows reported as "indexed for opponent pricing",
// all of them garbage, now feeding the opponent side of every matchup.
const fpRoster = [
  { id: "k1", name: "Cameron Dicker", team: "LAC", pos: "K", ecr: "" },
  { id: "t1", name: "Brock Bowers", team: "LV", pos: "TE", ecr: "" },
];
const fpPaste = [
  "1,TE,Trey McBride,ARI,vs. SEA,3 out of 5 stars,A+,15.5,+2.2,56% (9/16)",
  "35,TE,Brock Bowers,LV,at LAC,4 out of 5 stars,F,5.5,-,-",
  "2,K,Cameron Dicker,LAC,vs. LV,4 out of 5 stars,B+,9.1,+2.5,75% (12/16)",
].join("\n");
const fpParsed = parseProjections(fpPaste, fpRoster);
const byName = (n) => fpParsed.rows.find((r) => r.name === n);
check(
  "a headerless FantasyPros row yields the PROJECTION, not the start% denominator",
  byName("Trey McBride")?.proj === 15.5 && byName("Cameron Dicker")?.proj === 9.1,
  JSON.stringify(fpParsed.rows.map((r) => [r.name, r.proj]))
);
check(
  "the name is the player, not the whole line",
  !!byName("Brock Bowers") && !!byName("Trey McBride"),
  JSON.stringify(fpParsed.rows.map((r) => r.name))
);
check(
  "team and position survive the comma layout",
  byName("Trey McBride")?.team === "ARI" && byName("Trey McBride")?.pos === "TE",
  JSON.stringify(fpParsed.rows.map((r) => [r.name, r.team, r.pos]))
);
check(
  "and my own players finally match",
  fpParsed.matched.length === 2,
  `matched ${fpParsed.matched.length}/2: ${JSON.stringify(fpParsed.matched.map((m) => [m.player.name, m.proj]))}`
);
check(
  "stars still come through from the same row",
  byName("Cameron Dicker")?.stars === 4,
  `got ${byName("Cameron Dicker")?.stars}`
);

// ---- 28. expert projections: parse, blend, widen, label ----
const projRoster = [
  { id: "x1", name: "Chase Brown", team: "CIN", pos: "RB", ecr: "" },
  { id: "x2", name: "Keenan Allen", team: "LAC", pos: "WR", ecr: "" },
  { id: "x3", name: "Steelers D/ST", team: "PIT", pos: "D/ST", ecr: "" },
];
const csv = [
  '"RK","PLAYER NAME","TEAM","OPP","MATCHUP","PROJ. FPTS"',
  '1,"Chase Brown","CIN","@CLE","3 out of 5 stars",17.6',
  '2,"Keenan Allen","LAC","vs KC","1 out of 5 stars",3.1',
  '3,"Steelers","PIT","@NYJ","5 out of 5 stars",9.4',
].join("\n");
const pj = parseProjections(csv, projRoster);
check("a pasted FantasyPros CSV parses with its header", pj.sawHeader === true && pj.rows.length === 3, JSON.stringify({ h: pj.sawHeader, n: pj.rows.length }));
check("all three rows match, D/ST included", pj.matched.length === 3, JSON.stringify(pj.matched.map((m) => m.player.name)));
check(
  "the projection column is read",
  pj.matched.find((m) => m.player.id === "x2").proj === 3.1,
  JSON.stringify(pj.matched.map((m) => [m.player.name, m.proj]))
);
check(
  "matchup stars are captured in the same pass",
  pj.matched.find((m) => m.player.id === "x1").stars === 3 &&
    pj.matched.find((m) => m.player.id === "x3").stars === 5,
  JSON.stringify(pj.matched.map((m) => [m.player.name, m.stars]))
);
// free-form (no header) paste
const freeform = parseProjections("1 Chase Brown CIN @CLE 3 out of 5 stars 17.6", projRoster);
check(
  "a header-less table paste still parses",
  freeform.matched.length === 1 && freeform.matched[0].proj === 17.6 && freeform.matched[0].stars === 3,
  JSON.stringify(freeform.matched.map((m) => [m.player.name, m.proj, m.stars]))
);

// --- the blend ---
const blendState = (espn, fp, weights) => ({
  week: "1",
  players: { b1: { id: "b1", name: "Blend Guy", team: "KC", pos: "WR", status: "" } },
  analytics: { b1: { 1: { proj: espn, projSource: "espn", fpProj: fp } } },
  byes: {},
  espn: null,
  ...(weights ? { projWeights: weights } : {}),
});
const agree = pointDistribution({ id: "b1", name: "Blend Guy", team: "KC", pos: "WR", status: "" }, "1", blendState(14.2, 14.7));
const split = pointDistribution({ id: "b1", name: "Blend Guy", team: "KC", pos: "WR", status: "" }, "1", blendState(7.1, 3.1));
check(
  "two sources blend at equal weight by default",
  Math.abs(agree.mean - 14.45) < 0.06,
  `got ${agree.mean}, expected the midpoint of 14.2 and 14.7`
);
check(
  "the blend is labelled an assumption, not a derived weighting",
  /assumed/.test(agree.source),
  `source read "${agree.source}"`
);
check(
  "sources 4 pts apart produce a WIDER sd than sources agreeing",
  split.sd / split.mean > agree.sd / agree.mean,
  `split cv ${(split.sd / split.mean).toFixed(3)} vs agreeing cv ${(agree.sd / agree.mean).toFixed(3)}`
);
check(
  "measured weights, once earned, are labelled measured and actually shift the mean",
  (() => {
    const m = pointDistribution(
      { id: "b1", name: "Blend Guy", team: "KC", pos: "WR", status: "" },
      "1",
      blendState(10, 20, { espn: 0.8, fp: 0.2, basis: "measured" })
    );
    return Math.abs(m.mean - 12) < 0.06 && /measured/.test(m.source);
  })(),
  "expected 0.8*10 + 0.2*20 = 12 and a 'measured' label"
);
// stars must NOT reach the projection — FP already prices the matchup
const withStars = pointDistribution(
  { id: "b1", name: "Blend Guy", team: "KC", pos: "WR", status: "" },
  "1",
  { ...blendState(12, 12), analytics: { b1: { 1: { proj: 12, projSource: "espn", fpProj: 12, matchupStars: 1 } } } }
);
const withoutStars = pointDistribution({ id: "b1", name: "Blend Guy", team: "KC", pos: "WR", status: "" }, "1", blendState(12, 12));
check(
  "matchup stars are context only and never move the projection",
  withStars.mean === withoutStars.mean && withStars.sd === withoutStars.sd,
  "FantasyPros already prices the matchup into its number; counting stars too would double-dip"
);

// --- weights are earned, not assumed ---
const gradedRows = (n, espnErr, fpErr) => {
  const rows = {};
  for (let i = 0; i < n; i++) {
    rows[`p${i}`] = { actual: 10, sources: { espn: 10 + espnErr, fp: 10 + fpErr } };
  }
  return { calibration: { 1: rows } };
};
check(
  "below the threshold the weighting stays an explicit prior",
  projWeights(gradedRows(10, 1, 4)).basis === "assumed",
  JSON.stringify(projWeights(gradedRows(10, 1, 4)))
);
const earned = projWeights(gradedRows(80, 1, 4));
check(
  "past the threshold it refits from observed accuracy and says so",
  earned.basis === "measured" && earned.espn > earned.fp,
  JSON.stringify(earned)
);
check(
  "the more accurate source gets the larger weight, proportional to its error",
  Math.abs(earned.espn - 0.8) < 0.02,
  `ESPN mae 1, FP mae 4 → expected ~0.80 / 0.20, got ${earned.espn} / ${earned.fp}`
);

// --- weeklyProj provenance ---
check(
  "a real weekly projection is labelled weekly",
  weeklyProjBasis({ stats: [{ statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 12.4 }] }, 1) === "weekly"
);
check(
  "a season projection used as a per-game baseline is labelled season/17",
  weeklyProjBasis({ stats: [{ statSourceId: 1, statSplitTypeId: 0, appliedTotal: 217.6 }] }, 1) === "season/17",
  "this is the switch that moved a player 45% with no news behind it"
);

// ---- 29. the kickoff countdown ----
// It read "611h 42m" three weeks out, which is technically correct and
// unreadable. Boundaries are where time formatting goes wrong, so they're
// pinned rather than eyeballed.
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
check("the real case: 611h 42m now reads in days", formatCountdown(611 * HOUR + 42 * MIN) === "25d 11h 42m", `got ${formatCountdown(611 * HOUR + 42 * MIN)}`);
check("under an hour shows minutes only", formatCountdown(42 * MIN) === "42m", `got ${formatCountdown(42 * MIN)}`);
check("59 minutes stays minutes", formatCountdown(59 * MIN) === "59m", `got ${formatCountdown(59 * MIN)}`);
check("exactly 60 minutes rolls to hours", formatCountdown(60 * MIN) === "1h 0m", `got ${formatCountdown(60 * MIN)}`);
check("under a day shows hours + minutes, no days", formatCountdown(23 * HOUR + 59 * MIN) === "23h 59m", `got ${formatCountdown(23 * HOUR + 59 * MIN)}`);
check("exactly 24h rolls to days", formatCountdown(DAY) === "1d 0h 0m", `got ${formatCountdown(DAY)}`);
check("a past kickoff returns null, not a negative clock", formatCountdown(-5 * MIN) === null && formatCountdown(0) === null);
check("garbage in returns null", formatCountdown(NaN) === null && formatCountdown(undefined) === null);
// Pin `now` rather than letting it default to Date.now(). Building the ISO
// string and reading the clock inside untilKick are two separate reads, and a
// single millisecond between them turns 8040000ms into 8039999ms — which
// floors to "2h 13m" and fails. Measured at roughly 1 run in 5 under load.
// untilKick takes `now` for exactly this reason; the test just wasn't using it.
const kickNow = Date.UTC(2026, 8, 10, 12, 0, 0);
check("untilKick accepts an ISO string", untilKick(new Date(kickNow + 2 * HOUR + 14 * MIN).toISOString(), kickNow) === "2h 14m");
check("untilKick on an unparseable date returns null", untilKick("not-a-date") === null && untilKick(null) === null);

// ---- 30. position need in points, not mixed rank scales ----
const needState = {
  week: "1",
  players: {
    a: { id: "a", name: "Good WR", team: "KC", pos: "WR", status: "" },
    b: { id: "b", name: "Mid WR", team: "BUF", pos: "WR", status: "" },
    q: { id: "q", name: "My QB", team: "JAX", pos: "QB", status: "" },
  },
  lineup: { QB: ["q"], RB: [null, null], WR: ["a", "b", null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: [null], ir: [null],
  analytics: { a: { 1: { proj: 16, projSource: "espn" } }, b: { 1: { proj: 8, projSource: "espn" } }, q: { 1: { proj: 20, projSource: "espn" } } },
  byes: {}, espn: null, ecrIndex: {},
};
const np = positionNeedPoints(needState, "1");
check(
  "need is the average of the top N by POINTS, zero-filled for missing depth",
  // WR depth 4: 16, 8, 0, 0 → 6.0
  np.WR === 6 && np.QB === 20,
  JSON.stringify(np)
);
check(
  "a position with nobody scores 0, not a sentinel rank",
  np.TE === 0 && np["D/ST"] === 0,
  `TE ${np.TE}, D/ST ${np["D/ST"]}`
);
check(
  "every value is in points, so a difference has one unit",
  Object.values(np).every((v) => Number.isFinite(v) && v >= 0 && v < 60),
  JSON.stringify(np)
);
// the old rank version is still exported for display copy, and still ranks
check("the rank version still returns rank-scale numbers for display", (() => {
  const r = positionNeeds(needState);
  return Number.isFinite(r.WR) && r.WR > 100;
})());

// ---- 31. projection gauge geometry ----
// Rendering it proves nothing about where the needle points. These are the
// properties a render check can't see.
const { gaugeGeometry, angleFor, tickHeat, MAX: GAUGE_MAX } = await import("../src/gaugeGeometry.js");

check("the dial is a fixed 0-40 for every position, so needle position is comparable", GAUGE_MAX === 40);
// A 224-degree sweep from 202 deg: wider than a half circle, so the ends drop
// below horizontal and it reads as an instrument face, not a progress bar.
check("0 sits at the left end and the max at the right end", angleFor(0) === 202 && angleFor(GAUGE_MAX) === -22);
check(
  "an over-scale value pins to the dial end instead of swinging past it",
  angleFor(44) === -22 && angleFor(1000) === -22,
  `got ${angleFor(44)} / ${angleFor(1000)}`
);
check("a negative value pins to the left end rather than wrapping", angleFor(-5) === 202);
check(
  "the needle angle DECREASES as the value rises — left to right across the face",
  angleFor(0) > angleFor(20) && angleFor(20) > angleFor(40)
);
check(
  "ticks burn hottest at the needle and fade with distance",
  tickHeat(20, 20) === 1 && tickHeat(24.5, 20) === 0.5 && tickHeat(40, 20) === 0,
  `${tickHeat(20, 20)} / ${tickHeat(24.5, 20)} / ${tickHeat(40, 20)}`
);
check(
  "heat never goes negative for a far-away tick",
  tickHeat(0, 39) === 0 && tickHeat(40, 0) === 0
);

// Bijan, off the live roster: healthy, so both needles coincide and no ghost.
const gHealthy = gaugeGeometry({ mean: 24.7, condMean: 24.7, sd: 13.5, playProb: 1 });
check("a healthy player draws no ghost needle", gHealthy.ghost === null && !gHealthy.uncertain);
check(
  "floor and ceiling are condMean -/+ sd",
  gHealthy.floor === 11.2 && gHealthy.ceiling === 38.2,
  `${gHealthy.floor} .. ${gHealthy.ceiling}`
);
check("a healthy needle sits inside its own band", !gHealthy.needleOutsideBand);

// Brock Bowers: 14.9 if he plays, playProb 0.25 -> mean 3.7, BELOW his floor.
// This is the case the ghost needle exists for; it must not be smoothed away.
const gDoubt = gaugeGeometry({ mean: 3.7, condMean: 14.9, sd: 8.9, playProb: 0.25 });
check("a doubtful player draws a ghost needle at condMean", gDoubt.ghost === angleFor(14.9));
check(
  "the needle is allowed OUTSIDE the band when playProb drags mean below the floor",
  gDoubt.needleOutsideBand && 3.7 < gDoubt.floor,
  `mean 3.7 vs floor ${gDoubt.floor}`
);
// Angle decreases as value rises, so the higher condMean has the SMALLER angle.
check("the ghost sits further round the dial than the real needle", gDoubt.ghost < gDoubt.needle);

// A wide sd on a small projection would put the floor below zero.
const gLow = gaugeGeometry({ mean: 3, condMean: 3, sd: 5, playProb: 1 });
check("the floor clamps at 0 rather than going negative", gLow.floor === 0, `got ${gLow.floor}`);

// ---- 32. live projection decay ----
// The Gameday rows rendered a STATIC pregame number from a different source
// than the sim at the top of the same screen: Stafford sat at 22.2 with 1
// point scored and a quarter to play. Both now call liveProjection().
const { liveProjection, remainingFraction } = await import("../src/simulate.js");

check(
  "pre-kickoff is untouched — nothing has happened to decay yet",
  liveProjection({ pregame: 18.4, ifPlays: 18.4, scored: 0, status: "notStarted" }) === 18.4
);
check(
  "the real case: 22.2 pregame, 1 scored, a quarter left -> 6.6, not 22.2",
  liveProjection({ pregame: 22.2, ifPlays: 22.2, scored: 1, pctRemaining: 0.25, status: "inProgress" }) === 6.6,
  `got ${liveProjection({ pregame: 22.2, ifPlays: 22.2, scored: 1, pctRemaining: 0.25, status: "inProgress" })}`
);
check(
  "a final game projects EXACTLY the actual — no estimate survives it",
  liveProjection({ pregame: 22.2, ifPlays: 22.2, scored: 7.3, pctRemaining: 0, status: "final" }) === 7.3
);
check(
  "ruled out COLLAPSES to points banked rather than decaying gently",
  liveProjection({ pregame: 14, ifPlays: 14, scored: 0, pctRemaining: 0.8, status: "inProgress", playProb: 0 }) === 0,
  "a slow fade reads as 'still has a chance' when he does not"
);
check(
  "a projection is never below points already scored",
  liveProjection({ pregame: 4, ifPlays: 4, scored: 19.6, pctRemaining: 0.05, status: "inProgress" }) >= 19.6,
  `got ${liveProjection({ pregame: 4, ifPlays: 4, scored: 19.6, pctRemaining: 0.05, status: "inProgress" })}`
);
check(
  "once underway the REMAINING portion accrues at the if-he-plays rate, not the injury-discounted one",
  liveProjection({ pregame: 7, ifPlays: 14, scored: 2, pctRemaining: 0.5, status: "inProgress" }) === 9,
  `got ${liveProjection({ pregame: 7, ifPlays: 14, scored: 2, pctRemaining: 0.5, status: "inProgress" })}`
);
check(
  "kickoff-to-final the fraction runs 1 -> 0 and clamps outside that",
  remainingFraction("notStarted", 1) === 1 &&
    remainingFraction("final", 0.5) === 0 &&
    remainingFraction("inProgress", 1.4) === 1 &&
    remainingFraction("inProgress", -3) === 0
);
check(
  "no projection at all still reports points banked rather than null mid-game",
  liveProjection({ pregame: null, ifPlays: null, scored: 5.5, pctRemaining: 0.4, status: "inProgress" }) === 5.5
);

// ---- 33. opponent data provenance ----
// The UI used to infer "are these real projections" from state.espn being
// truthy. That blob is persisted from the last good sync and outlives the
// sync itself, so the screen claimed real ESPN numbers while running rank
// estimates. Ask the code that builds them instead.
const { opponentSource, espnAgeMs, staleAfterMs, myGameLive, agoLabel, STALE_LIVE_MS, STALE_IDLE_MS } = await import("../src/simulate.js");

const oppBase = {
  week: "1",
  matchups: { 1: { oppTeam: "Substation" } },
  ecrIndex: { dakprescott: 30 },
};
check(
  "no opponent set reports none, not a false 'live'",
  opponentSource({ ...oppBase, matchups: {} }, "1") === "none"
);
check(
  "with no espn blob at all, a known league team falls back to estimates",
  opponentSource({ ...oppBase, espn: null }, "1") === "estimated",
  `got ${opponentSource({ ...oppBase, espn: null }, "1")}`
);
check(
  "THE CASE THAT MATTERS: state.espn present but the opponent is missing from it still reports estimated",
  opponentSource({ ...oppBase, espn: { teams: [{ id: 1, name: "Someone Else", roster: [{ name: "X" }] }] } }, "1") ===
    "estimated",
  "a truthy state.espn must never be read as proof the numbers are real"
);
check(
  "an opponent actually present in the espn blob reports live",
  opponentSource(
    { ...oppBase, espn: { teams: [{ id: 2, name: "Substation", mapped: "Substation", roster: [{ name: "Dak" }] }] } },
    "1"
  ) === "live"
);
check(
  "a sync that never happened has no age rather than an age of zero",
  espnAgeMs({ espn: null }) === null && espnAgeMs({}) === null
);
check(
  "staleness is measured from fetchedAt",
  espnAgeMs({ espn: { fetchedAt: 1000 } }, 1000 + 7200000) === 7200000
);
// The threshold is conditional: "too old" at 1pm Sunday is not "too old" on a
// Tuesday. Gameday polls every 2 minutes while a game is live, so the tight
// bound is five missed polls and cannot fire during healthy operation.
const liveSt = {
  players: { a: { team: "JAX" }, b: { team: "ATL" } },
  espn: { fetchedAt: 0, games: { JAX: { state: "in" }, ATL: { state: "pre" } } },
};
const idleSt = {
  players: { a: { team: "JAX" } },
  espn: { fetchedAt: 0, games: { JAX: { state: "pre" } } },
};
check("a player on the field makes the state live", myGameLive(liveSt) === true);
check("nobody on the field is not live", myGameLive(idleSt) === false);
check(
  "a game live for a team I have NO player on does not tighten the bound",
  myGameLive({ players: { a: { team: "JAX" } }, espn: { games: { KC: { state: "in" } } } }) === false,
  "scoped to this roster on purpose — frozen data isn't urgent if nobody is playing"
);
check(
  "live slate uses the tight 10-minute bound",
  staleAfterMs(liveSt) === STALE_LIVE_MS && STALE_LIVE_MS === 10 * 60 * 1000
);
check(
  "off-slate falls back to 3 hours, so a Wednesday doesn't nag",
  staleAfterMs(idleSt) === STALE_IDLE_MS && STALE_IDLE_MS === 3 * 60 * 60 * 1000
);
check(
  "the tight bound is well outside the 2-minute poll — no false positives when healthy",
  STALE_LIVE_MS / 120000 === 5
);
check(
  "age reads at a scale that makes sense — an hours-only label would render the most important warning as '0h'",
  agoLabel(12 * 60000) === "12m" && agoLabel(4 * 3600000) === "4h" && agoLabel(50 * 3600000) === "2d",
  `${agoLabel(12 * 60000)} / ${agoLabel(4 * 3600000)} / ${agoLabel(50 * 3600000)}`
);

// ---- 34. head-to-head pairing ----
// The layout's whole value is that row N left and row N right are the SAME
// slot. If the alignment is ever wrong the screen invites a comparison that
// isn't real — a QB opposite a kicker.
const { pairBySlot, shortName, H2H_SLOT_ORDER } = await import("../src/headToHead.js");

const L = [
  { slot: "QB", name: "My QB" }, { slot: "RB", name: "My RB1" }, { slot: "RB", name: "My RB2" },
  { slot: "K", name: "My K" }, { slot: "BE", name: "My Bench" },
];
const Rr = [
  { slot: "K", name: "Opp K" }, { slot: "QB", name: "Opp QB" }, { slot: "RB", name: "Opp RB1" },
  { slot: "IR", name: "Opp IR" },
];
const paired = pairBySlot(L, Rr);
check(
  "every row pairs the SAME slot on both sides",
  paired.every((p) => (!p.mine || p.mine.slot === p.slot) && (!p.theirs || p.theirs.slot === p.slot))
);
check(
  "slots come out in display order regardless of input order",
  paired.map((p) => p.slot).join(",") === "QB,RB,RB,K",
  paired.map((p) => p.slot).join(",")
);
check(
  "bench and IR are excluded — they have no counterpart to pair against",
  !paired.some((p) => p.slot === "BE" || p.slot === "IR")
);
check(
  "an uneven slot zips to the LONGER side rather than dropping a player",
  paired.filter((p) => p.slot === "RB").length === 2 &&
    paired.find((p) => p.slot === "RB" && p.theirs === null) != null,
  "my 2 RBs vs their 1 must still show both of mine"
);
check("an empty opponent still renders my whole lineup", pairBySlot(L, []).length === 4);
check("both sides empty is empty, not a crash", pairBySlot([], []).length === 0);
check(
  "names shorten to initial + surname so a two-column board doesn't shred them",
  shortName("Trevor Lawrence") === "T. Lawrence" && shortName("Mike Washington Jr.") === "M. Washington Jr.",
  `${shortName("Trevor Lawrence")} / ${shortName("Mike Washington Jr.")}`
);
check(
  "single-word names are left alone — 'S. teelers' would be nonsense",
  shortName("Steelers") === "Steelers" && shortName("") === ""
);
check(
  "a defense keeps its TEAM name — 'L. D/ST' reads as a player with a slot for a surname",
  shortName("Lions D/ST") === "Lions" && shortName("Steelers D/ST") === "Steelers",
  `${shortName("Lions D/ST")} / ${shortName("Steelers D/ST")}`
);
check("the slot order covers a full starting lineup", H2H_SLOT_ORDER.length === 7);

// ---- 35. yet-to-play breakdown ----
// "yet to play (10)" hides the difference between a QB + 3 RB + 3 WR still to
// come and a kicker plus a defense. That distinction IS the read on whether a
// lead is comfortable or cooked.
const { yetToPlay, yetToPlayLabel, seedFor, recordLabel, opponentOf } = await import("../src/headToHead.js");

const ytpRows = [
  { name: "QB", slot: "QB", pos: "QB", l: { status: "notStarted" } },
  { name: "RB1", slot: "RB", pos: "RB", l: { status: "notStarted" } },
  { name: "RB2", slot: "RB", pos: "RB", l: { status: "notStarted" } },
  { name: "FlexRB", slot: "FLEX", pos: "RB", l: { status: "notStarted" } },
  { name: "WR1", slot: "WR", pos: "WR", l: { status: "notStarted" } },
  { name: "DST", slot: "D/ST", pos: "D/ST", l: { status: "notStarted" } },
  { name: "K", slot: "K", pos: "K", l: { status: "notStarted" } },
  { name: "Playing", slot: "WR", pos: "WR", l: { status: "inProgress" } },
  { name: "Done", slot: "TE", pos: "TE", l: { status: "final" } },
  { name: "Bench", slot: "BE", pos: "WR", l: { status: "notStarted" } },
];
const ytp = yetToPlay(ytpRows);
check(
  "in-progress and final players are NOT yet to play — they are already accruing",
  ytp.count === 7,
  `got ${ytp.count}`
);
check("bench is excluded from the count", !ytp.parts.some((p) => p.pos === "BE"));
check(
  "a FLEX counts under the player's real position, not as 'FLEX'",
  ytp.parts.find((p) => p.pos === "RB").n === 3,
  "a flexed RB is RB firepower"
);
check(
  "the label reads like Sleeper's, with a bare 1 left implicit",
  yetToPlayLabel(ytp) === "QB, 3 RB, WR, DEF, K",
  yetToPlayLabel(ytp)
);
check("nothing left to play yields an empty label, not '0'", yetToPlayLabel(yetToPlay([])) === "");
check(
  "record hides ties unless there are any",
  recordLabel({ w: 0, l: 0, t: 0 }) === "0-0" && recordLabel({ w: 2, l: 1, t: 1 }) === "2-1-1"
);
check(
  "seed ranks by wins, then points for",
  seedFor(
    [
      { id: 1, record: { w: 1, l: 0 }, pointsFor: 90 },
      { id: 2, record: { w: 1, l: 0 }, pointsFor: 120 },
      { id: 3, record: { w: 0, l: 1 }, pointsFor: 200 },
    ],
    1
  ) === 2,
  "more points breaks a tie on record"
);
check("a team not in the list has no seed rather than a wrong one", seedFor([], 7) === null);
check(
  "opponent parses home and away",
  opponentOf("@PIT").at === true && opponentOf("CLE").at === false && opponentOf("") === null,
  "vs / @ must be right or the row lies about where the game is"
);

// ---- 36. narrative perspective ----
// The callout must ALWAYS be written in second person about MY team, whichever
// side of the ESPN matchup my team happens to sit on. Asserted because the
// screen gives no other way to tell: with no "you" marker on the board, a
// reader can attribute the wrong side to himself and conclude the app is
// narrating from the opponent's chair when it is not.
const { liveNarrative: narr } = await import("../src/simulate.js");

// myTeam TRAILS on the scoreboard but has more players left.
const behindMoreLeft = narr({ winProb: 0.75, tieProb: 0, myNow: 0, oppNow: 8, myLeft: 4, oppLeft: 2 });
check(
  "trailing with more to play reads as MY deficit, not the opponent's",
  /down 8/i.test(behindMoreLeft) && /more player/i.test(behindMoreLeft),
  behindMoreLeft
);
// myTeam LEADS but has fewer players left.
const aheadFewerLeft = narr({ winProb: 0.25, tieProb: 0, myNow: 8, oppNow: 0, myLeft: 2, oppLeft: 4 });
check(
  "leading with fewer to play reads as MY lead being fragile",
  /up 8/i.test(aheadFewerLeft) && /they have 2 more/i.test(aheadFewerLeft),
  aheadFewerLeft
);
check(
  "the two situations never produce the same sentence",
  behindMoreLeft !== aheadFewerLeft
);
check(
  "a finished week reports MY result",
  /you won/i.test(narr({ winProb: 1, tieProb: 0, myNow: 120, oppNow: 90, myLeft: 0, oppLeft: 0 })) &&
    /you lost/i.test(narr({ winProb: 0, tieProb: 0, myNow: 90, oppNow: 120, myLeft: 0, oppLeft: 0 }))
);
check(
  "my lineup being done is phrased about MY lineup",
  /your lineup is done/i.test(narr({ winProb: 0.4, tieProb: 0, myNow: 110, oppNow: 100, myLeft: 0, oppLeft: 3 }))
);

// ---- 36b. snapshots carry the intelligence layer ----
// A device set up by snapshot had no props and no matchup stars: packState
// dropped `analytics` entirely. It read as missing DATA rather than a missing
// transfer, because a later ESPN sync repopulates `proj` and nothing else.
const { packState, encodeShare: enc, decodeShare: dec } = await import("../src/share.js");
const snapState = {
  v: 2,
  week: "1",
  players: { a: { id: "a", name: "Trevor Lawrence", pos: "QB", team: "JAX", ecr: "QB9" } },
  lineup: { QB: ["a"] },
  bench: [],
  ir: [],
  watch: [],
  calls: [],
  claims: [],
  faab: 99,
  analytics: {
    a: { 1: { proj: 20.7, fpProj: 19.4, matchupStars: 1, propsProj: 23.1, propsParts: [["245.5 pass yds", 9.8]], propsSource: "odds-api" } },
  },
  ecrIndex: { someone: 12 },
};
const packed = packState(snapState);
check("a snapshot carries analytics", !!packed.analytics, "without it the card shows no props on a new device");
check(
  "props survive the round trip — the whole point of the card",
  dec(enc(snapState)).analytics.a[1].propsProj === 23.1 &&
    dec(enc(snapState)).analytics.a[1].propsParts.length === 1
);
check("matchup stars survive too", dec(enc(snapState)).analytics.a[1].matchupStars === 1);
check(
  "ecrIndex still does NOT travel — 27KB of pasted rankings, re-pasteable",
  packed.ecrIndex === undefined
);
check(
  "the ranks-imported week does not travel either — a stamp with no index behind it is a lie",
  packed.ecrWeek === undefined
);
check(
  "nor does the pasted projection index — bulky, re-pasteable, same call as ecrIndex",
  packed.fpProjIndex === undefined
);
check(
  "nor the slate-wide props index — refetched automatically, never worth a URL",
  packed.propsIndex === undefined
);
check(
  "the props index round-trips through migrate",
  JSON.stringify(migrate({ propsIndex: { 1: { x: { proj: 9, parts: [] } } } }).propsIndex) ===
    JSON.stringify({ 1: { x: { proj: 9, parts: [] } } }) &&
    JSON.stringify(migrate({ propsIndex: "junk" }).propsIndex) === "{}",
  JSON.stringify(migrate({ propsIndex: "junk" }).propsIndex)
);

// ---- 36b. no opponent row is built from raw ESPN ----
// Twice now the ARITHMETIC was right and the WIRING was not. A2 routed
// opponentDist through the shared blend and the board kept its own copy off
// `e.proj`; the fix for that went into teamRows, which only runs when browsing
// someone else's matchup, while Kyle's own matchup renders from oppSide. Both
// times every assertion passed and only a screenshot showed the opponent
// column still sitting on ESPN's raw number.
//
// So this checks the wiring, not the maths: every opponent row builder in
// Gameday has to go through the one pricing function.
const gdSrc = fsMod.readFileSync("src/components/Gameday.jsx", "utf8");
const oppBuilders = (gdSrc.match(/opponentDist\(state, week, e\)/g) || []).length;
check(
  "both opponent row builders price through opponentDist, not e.proj",
  oppBuilders === 2,
  `found ${oppBuilders} call(s); oppSide (my own matchup) and teamRows (browsing another) both need one`
);
check(
  "no opponent row still assigns ESPN's raw projection straight to simProj",
  !/simProj:\s*proj,/.test(gdSrc),
  "`simProj: proj` is the shape the raw-ESPN builders had"
);

// ---- 36c. the drop candidate on Suggested Adds ----
// Kyle, on the card reading "+153 pts rest of season vs dropping Brock Bowers":
// "150 points if I what drop brock bowers that screen doesn't make any sense."
// He was right, and the cause was one `?? 0`.
//
// The card asked what Bowers was projected for this week, got nothing back,
// and wrote down 0.0. That single zero did two jobs and got both wrong: it
// made him the WEAKEST player at the position, so he was nominated as the
// drop, and it made his rest-of-season value ZERO, so the newcomer's entire
// season total showed up as points gained. +153 was not a comparison. It was
// the newcomer's own season projection with nothing subtracted.
//
// A missing projection is UNKNOWN, not worthless. So is a zero: a man on his
// bye is not your worst player, he is your worst player this week.
const dcState = (analytics) => ({
  week: "3",
  analytics,
  players: {
    te1: { id: "te1", name: "Brock Bowers", team: "LV", pos: "TE" },
    te2: { id: "te2", name: "Spare TE", team: "NYJ", pos: "TE" },
  },
});
const noProj = dropCandidate(dcState({ te2: { 3: { proj: 6.1 } } }), "3", "TE");
check(
  "a player with NO projection this week is not nominated as the drop",
  noProj != null && noProj.p.name === "Spare TE",
  `nominated ${noProj ? noProj.p.name : "nobody"} at ${noProj ? noProj.proj : "-"} — an unprojected Bowers used to win this at 0.0`
);
const onBye = dropCandidate(dcState({ te1: { 3: { proj: 0 } }, te2: { 3: { proj: 6.1 } } }), "3", "TE");
check(
  "a player projected zero (his bye) is not nominated either",
  onBye != null && onBye.p.name === "Spare TE",
  `nominated ${onBye ? onBye.p.name : "nobody"} — a bye is not a season-long verdict`
);
const noneKnown = dropCandidate(dcState({}), "3", "TE");
check(
  "nobody projected at the position means NO drop candidate, not a fake one",
  noneKnown === null,
  `got ${noneKnown ? noneKnown.p.name : "null"} — with nothing known the card must say nothing`
);
const lone = dropCandidate(
  { week: "3", analytics: { te1: { 3: { proj: 9.4 } } }, players: { te1: { id: "te1", name: "Brock Bowers", team: "LV", pos: "TE" } } },
  "3",
  "TE"
);
check(
  "your ONLY player at a position is flagged as such, so the card can say swap",
  lone != null && lone.only === true,
  `only=${lone ? lone.only : "(no candidate)"} — "drop your only TE" is what alarmed him`
);
check(
  "with two at the position the weakest is NOT flagged as the only one",
  noProj != null && noProj.only === false,
  `only=${noProj ? noProj.only : "(no candidate)"}`
);

// The render must compare per WEEK. Multiplying one week's projection by the
// games left is what turned a 10-point edge into a 153-point headline.
const appSrc = fsMod.readFileSync("src/App.jsx", "utf8");
check(
  "the suggested-add line no longer extrapolates a season total",
  !/sug-ros[\s\S]{0,400}rest of season/.test(appSrc),
  "`rest of season` next to sug-ros is the flat weekly x games-left headline"
);
check(
  "the suggested-add line no longer defaults a missing drop value to zero",
  !/dropRos\s*=[\s\S]{0,80}\?\?\s*0/.test(appSrc),
  "`?? 0` on the drop's value is how the newcomer's whole season became the delta"
);

// ---- 36d. the Vegas props gameday window ----
// Props are the top rung of the projection ladder, and how fresh they are is
// decided by whether today is a game day: 3h inside the window, 12h outside.
// That question was asked in UTC.
//
// An NFL night game kicks at 8:15pm Eastern, which is already TOMORROW in UTC.
// Every UTC day window therefore sits four or five hours EARLY against the
// schedule it is meant to track, and each one expires at the worst possible
// moment: the "Thursday" window runs Wednesday 8pm ET to Thursday 8pm ET, so
// the lines go stale exactly as Thursday Night Football kicks off, having been
// kept fresh all Wednesday evening when nothing was being played. "Monday"
// does the same to Monday Night Football. Sunday's day games are the only
// ones the UTC reading gets right, and only by accident.
//
// (The same trap cost this session a wrong answer, when the container clock
// said Sunday and it was Saturday night where Kyle was sitting.)
//
// The league schedules in Eastern time, so the question is asked in Eastern.
const ET_CASES = [
  ["Thursday Night Football, 8:15pm ET", "2026-09-17T20:15:00-04:00", true],
  ["Thursday 11am ET, hours before TNF", "2026-09-17T11:00:00-04:00", true],
  ["Sunday early window, 1:00pm ET", "2026-09-20T13:00:00-04:00", true],
  ["Sunday Night Football, 8:20pm ET", "2026-09-20T20:20:00-04:00", true],
  ["Monday Night Football, 8:15pm ET", "2026-09-21T20:15:00-04:00", true],
  ["Wednesday 8:15pm ET — used to be \"Thursday\" in UTC", "2026-09-16T20:15:00-04:00", false],
  ["Tuesday 8:15pm ET, the dead night", "2026-09-22T20:15:00-04:00", false],
  ["Wednesday 1pm ET", "2026-09-23T13:00:00-04:00", false],
];
for (const [label, iso, want] of ET_CASES) {
  const got = isGameday(new Date(iso));
  check(
    `gameday window: ${label} → ${want ? "3h" : "12h"} TTL`,
    got === want,
    `isGameday said ${got}; UTC day was ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(iso).getUTCDay()]}`
  );
}
// The two that matter most, stated as the defect rather than a day-of-week:
check(
  "a night game is never read as the NEXT day",
  isGameday(new Date("2026-09-17T20:15:00-04:00")) && isGameday(new Date("2026-09-21T20:15:00-04:00")),
  "TNF and MNF both kick after 00:00 UTC, which is how they fell out of the window"
);

// ---- 36e. the optimizer must respect kickoff ----
// Found while sizing, not reported: mid-slate the Today tab said
//
//   GAMES ARE ON
//   One move worth making
//   Start Quentin Johnston over Parker Washington - +6.6% win probability
//
// with an Apply button, when BOTH of those games were already Final. Neither
// player could produce another point; Washington had gone off for 18.4 and
// Johnston had busted at 3.1. suggestLineup() scores everyone off the PREGAME
// distribution and never asks whether a game has started.
//
// The app already knows how to do this - for the other guy. bestLineupFrom()
// takes `pinned` for exactly this ("ids already committed to a slot - their
// game has kicked off"), opponentLineups() builds that map from espn.games
// with the comment "kickoff, not a choice their manager still has", and
// suggestLineup() passed nothing. The same asymmetry as the opponent pricing.
//
// Two rules, and they are ESPN's, not ours: a started player cannot be swapped
// OUT, and a started player cannot be swapped IN.
const LOCK_POS = { a: "QB", b: "QB" };
const mkLockState = (games) => ({
  v: 2,
  week: "1",
  players: {
    a: { id: "a", name: "Locked Starter", team: "KC", pos: LOCK_POS.a, ecr: "QB30", status: "", espnId: "a" },
    b: { id: "b", name: "Better Bench QB", team: "BUF", pos: LOCK_POS.b, ecr: "QB2", status: "", espnId: "b" },
  },
  lineup: { QB: ["a"], RB: [null, null], WR: [null, null, null], TE: [null], FLEX: [null], "D/ST": [null], K: [null] },
  bench: ["b", null, null, null, null, null],
  ir: [null, null],
  byes: {},
  byesAuto: {},
  byesManual: {},
  // b is projected far higher, so pregame the swap is genuinely right.
  analytics: { a: { 1: { proj: 6, projSource: "espn" } }, b: { 1: { proj: 22, projSource: "espn" } } },
  espn: { games },
  ecrIndex: {},
  schedule: null,
  matchups: {},
});
const pre = { KC: { state: "pre" }, BUF: { state: "pre" } };
const swapPre = suggestLineup(mkLockState(pre), "1", null).find((m) => m.inId === "b" && m.outId === "a");
check(
  "before kickoff the optimizer still recommends the genuine upgrade",
  !!swapPre,
  swapPre ? `proposed "${swapPre.inName} over ${swapPre.outName}"` : "proposed nothing — the guard has over-reached"
);
const outLocked = suggestLineup(mkLockState({ KC: { state: "in" }, BUF: { state: "pre" } }), "1", null);
check(
  "a starter whose game has KICKED OFF is never swapped out",
  !outLocked.some((m) => m.outId === "a"),
  `proposed ${JSON.stringify(outLocked.map((m) => `${m.inName} over ${m.outName}`))} — his lineup spot is settled`
);
const outFinal = suggestLineup(mkLockState({ KC: { state: "post" }, BUF: { state: "pre" } }), "1", null);
check(
  "a starter whose game is FINAL is never swapped out either",
  !outFinal.some((m) => m.outId === "a"),
  `proposed ${JSON.stringify(outFinal.map((m) => `${m.inName} over ${m.outName}`))}`
);
const inLocked = suggestLineup(mkLockState({ KC: { state: "pre" }, BUF: { state: "post" } }), "1", null);
check(
  "a bench player whose game is over is never swapped IN",
  !inLocked.some((m) => m.inId === "b"),
  `proposed ${JSON.stringify(inLocked.map((m) => `${m.inName} over ${m.outName}`))} — he cannot score again`
);
const bothDone = suggestLineup(mkLockState({ KC: { state: "post" }, BUF: { state: "post" } }), "1", null);
check(
  "with both games Final the optimizer proposes nothing at all",
  bothDone.length === 0,
  `proposed ${bothDone.length} move(s): ${JSON.stringify(bothDone.map((m) => `${m.inName} over ${m.outName}`))}`
);
// No sync, no game data, no locks - the behaviour must be exactly as before.
const noSync = suggestLineup({ ...mkLockState(pre), espn: null }, "1", null).find((m) => m.inId === "b");
check(
  "with ESPN unsynced nothing is treated as locked",
  !!noSync,
  "an absent espn.games must fall back to the old behaviour, not freeze the lineup"
);
// The rule is ESPN's own, and the opponent side already applies it. Wiring,
// not arithmetic - the check that would have caught this in the first place.
const analysisSrc = fsMod.readFileSync("src/analysis.js", "utf8");
check(
  "suggestLineup passes a pinned map to bestLineupFrom, as the opponent builder does",
  /bestLineupFrom\(\s*[\s\S]{0,400}?,\s*pinned\s*\)/.test(analysisSrc),
  "bestLineupFrom's second argument is the whole mechanism; calling it with one argument is the defect"
);

// ---- 37. no orphaned classNames ----
// Twice now a stylesheet edit truncated whole sections, and the app shipped
// with unstyled markup — a player card rendered as a wall of running text and
// the gauge as a black blob. Every check passed both times: the components
// RENDER fine without CSS. Nothing but a screenshot or this catches it.
const cssText = fsMod.readFileSync("src/index.css", "utf8");
const componentFiles = fsMod
  .readdirSync("src/components", { recursive: true })
  .filter((f) => String(f).endsWith(".jsx"))
  .map((f) => `src/components/${f}`);
const orphans = new Set();
for (const file of componentFiles) {
  const src = fsMod.readFileSync(file, "utf8");
  for (const m of src.matchAll(/className=[`"]([^`"$}]*)[`"]/g)) {
    for (const cls of m[1].split(/\s+/)) {
      // Skip interpolated fragments and anything conditional.
      if (!cls || /[^a-z0-9-]/i.test(cls)) continue;
      if (!cssText.includes(`.${cls}`)) orphans.add(cls);
    }
  }
}
check(
  "every static className rendered by a component has a rule in index.css",
  orphans.size === 0,
  orphans.size ? `orphaned: ${[...orphans].sort().join(", ")}` : ""
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll sanity checks passed.");
process.exit(failures ? 1 : 0);
