// Engine sanity checks — run with `node scripts/sanity.mjs`.
// Guards the three behaviours the app's honesty depends on:
//   1. scoring uses league values (6-pt pass TDs, rush attempts)
//   2. injury risk is bimodal (Q = 77% × outcome, floor 0)
//   3. correlation: stacked lineups are WIDER, QB-vs-opposing-D/ST narrower
import { propsToPoints, SCORING } from "../src/props.js";
import { pointDistribution, floorCeiling } from "../src/analytics.js";
import { simulateMatchup } from "../src/simulate.js";

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

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll sanity checks passed.");
process.exit(failures ? 1 : 0);
