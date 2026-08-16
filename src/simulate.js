// ============================================================================
// Monte Carlo matchup simulation.
//
// The whole reason this exists: fantasy sites tell you which player scores more
// points. That is a statement about the player, identical for everyone who owns
// him. Whether YOU should start the volatile guy depends on whether you're
// favoured or an underdog this week — chasing variance when you're behind and
// floor when you're ahead is the actual correct play, and it needs your matchup.
//
// Output is a win probability, so lineup decisions get compared on the thing
// that decides your season instead of on projected points.
// ============================================================================

import { SLOT_DEFS } from "./lineup.js";
import { pointDistribution } from "./analytics.js";

const RUNS = 20000;

/** Deterministic PRNG so the same inputs don't produce a jittering percentage. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, reused across a pair of draws. */
function makeNormal(rand) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

/**
 * Fantasy scores are right-skewed and never negative, so draw from a lognormal
 * matched to the requested mean/sd rather than a normal that can go below zero.
 */
function sampler(dist, normal) {
  const { mean, sd } = dist;
  if (!(mean > 0)) return () => 0;
  const variance = Math.max(sd * sd, 1e-6);
  const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)));
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  return () => Math.exp(mu + sigma * normal());
}

/** Distributions for every player in a starting lineup. */
export function lineupDistributions(state, lineup, week) {
  const out = [];
  const missing = [];
  for (const s of SLOT_DEFS) {
    for (const id of lineup[s.key] || []) {
      if (!id) continue;
      const p = state.players[id];
      if (!p) continue;
      const d = pointDistribution(p, week, state);
      if (d) out.push({ id, name: p.name, ...d });
      else missing.push(p.name);
    }
  }
  return { dists: out, missing };
}

export const sumMeans = (dists) => Math.round(dists.reduce((n, d) => n + d.mean, 0) * 10) / 10;

/**
 * @returns {{winProb, myMean, oppMean, myP10, myP90, margin}|null}
 */
export function simulateMatchup(myDists, oppDists, seed = 12345) {
  if (!myDists.length || !oppDists.length) return null;
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);
  const mine = myDists.map((d) => sampler(d, normal));
  const theirs = oppDists.map((d) => sampler(d, normal));

  let wins = 0;
  const totals = new Array(RUNS);
  let marginSum = 0;
  for (let i = 0; i < RUNS; i++) {
    let a = 0;
    for (const f of mine) a += f();
    let b = 0;
    for (const f of theirs) b += f();
    totals[i] = a;
    marginSum += a - b;
    if (a > b) wins++;
  }
  totals.sort((x, y) => x - y);
  const pct = (q) => Math.round(totals[Math.floor(q * (RUNS - 1))] * 10) / 10;

  return {
    winProb: wins / RUNS,
    myMean: sumMeans(myDists),
    oppMean: sumMeans(oppDists),
    myP10: pct(0.1),
    myP90: pct(0.9),
    margin: Math.round((marginSum / RUNS) * 10) / 10,
  };
}

/**
 * Win probability if `inId` started in place of `outId`.
 * This is the number that actually answers "who should I start".
 */
export function simulateSwap(state, week, oppDists, outId, inId, seed = 12345) {
  const base = lineupDistributions(state, state.lineup, week);
  const swapped = base.dists.filter((d) => d.id !== outId);
  const p = state.players[inId];
  if (!p) return null;
  const d = pointDistribution(p, week, state);
  if (!d) return null;
  swapped.push({ id: inId, name: p.name, ...d });

  const before = simulateMatchup(base.dists, oppDists, seed);
  const after = simulateMatchup(swapped, oppDists, seed);
  if (!before || !after) return null;
  return { before, after, delta: after.winProb - before.winProb };
}

// ---------------------------------------------------------------- live ------

/**
 * Live, in-progress win probability.
 *
 * The case that makes this worth building: 200 points with every player done
 * beats 180 points on paper — but if that 180 has a player left on Monday
 * night projected for 25, the 180 team is actually the favourite. Raw points
 * are meaningless without knowing who still has football left to play.
 *
 * Each player contributes:
 *   final       → exactly what they scored, no variance at all
 *   not started → their full projected distribution
 *   in progress → what they've banked, plus the fraction of their projection
 *                 still to come. Variance scales with sqrt(remaining) because
 *                 a player with a quarter left is far more predictable than
 *                 one at kickoff.
 *
 * @param {Array} sides [{entries:[{proj, scored, pctRemaining, status, cv}]}]
 */
function liveTotalSampler(entries, normal) {
  const parts = entries.map((e) => {
    const scored = Number.isFinite(e.scored) ? e.scored : 0;
    if (e.status === "final") return () => scored;

    const remainingFrac = e.status === "inProgress" ? Math.max(0, Math.min(1, e.pctRemaining ?? 0)) : 1;
    const remainingMean = Math.max(0, (e.proj || 0) * remainingFrac);
    if (remainingMean <= 0) return () => scored;

    const cv = e.cv ?? 0.55;
    // Full-game sd shrunk by sqrt of the fraction still to be played.
    const sd = (e.proj || 0) * cv * Math.sqrt(remainingFrac);
    const variance = Math.max(sd * sd, 1e-6);
    const sigma = Math.sqrt(Math.log(1 + variance / (remainingMean * remainingMean)));
    const mu = Math.log(remainingMean) - (sigma * sigma) / 2;
    return () => scored + Math.exp(mu + sigma * normal());
  });
  return () => {
    let total = 0;
    for (const f of parts) total += f();
    return total;
  };
}

export function simulateLive(myEntries, oppEntries, seed = 991) {
  if (!myEntries.length || !oppEntries.length) return null;
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);
  const mine = liveTotalSampler(myEntries, normal);
  const theirs = liveTotalSampler(oppEntries, normal);

  let wins = 0;
  let ties = 0;
  const totals = new Array(RUNS);
  const oppTotals = new Array(RUNS);
  for (let i = 0; i < RUNS; i++) {
    const a = mine();
    const b = theirs();
    totals[i] = a;
    oppTotals[i] = b;
    if (a > b) wins++;
    else if (Math.abs(a - b) < 1e-9) ties++;
  }
  const sortedMine = [...totals].sort((x, y) => x - y);
  const sortedOpp = [...oppTotals].sort((x, y) => x - y);
  const q = (arr, p) => Math.round(arr[Math.floor(p * (RUNS - 1))] * 10) / 10;
  // Headline projection = MEAN, matching the sum of the player column (the
  // median of a right-skewed sim runs ~2% low and reads like a math error).
  const mean = (arr) => Math.round((arr.reduce((n, v) => n + v, 0) / arr.length) * 10) / 10;

  const banked = (es) => es.reduce((n, e) => n + (Number.isFinite(e.scored) ? e.scored : 0), 0);
  const yetToPlay = (es) => es.filter((e) => e.status !== "final").length;

  return {
    winProb: wins / RUNS,
    tieProb: ties / RUNS,
    myNow: Math.round(banked(myEntries) * 10) / 10,
    oppNow: Math.round(banked(oppEntries) * 10) / 10,
    myProjFinal: mean(totals),
    oppProjFinal: mean(oppTotals),
    myP10: q(sortedMine, 0.1),
    myP90: q(sortedMine, 0.9),
    myLeft: yetToPlay(myEntries),
    oppLeft: yetToPlay(oppEntries),
  };
}

/** Plain-English read on where the matchup stands. */
export function liveNarrative(sim) {
  if (!sim) return null;
  const p = sim.winProb;
  const lead = sim.myNow - sim.oppNow;
  const leftGap = sim.myLeft - sim.oppLeft;

  if (sim.myLeft === 0 && sim.oppLeft === 0) {
    return p > 0.5 ? "Final — you won." : "Final — you lost.";
  }
  if (sim.myLeft === 0) {
    return `Your lineup is done at ${sim.myNow}. ${sim.oppLeft} player${sim.oppLeft === 1 ? "" : "s"} left can still catch you.`;
  }
  if (sim.oppLeft === 0) {
    return `They're locked at ${sim.oppNow}. You need ${Math.max(0, Math.round((sim.oppNow - sim.myNow) * 10) / 10)} more from ${sim.myLeft} player${sim.myLeft === 1 ? "" : "s"}.`;
  }
  if (lead < 0 && leftGap > 0) {
    return `Down ${Math.abs(Math.round(lead * 10) / 10)} but with ${leftGap} more player${leftGap === 1 ? "" : "s"} to play — the scoreboard is lying to you.`;
  }
  if (lead > 0 && leftGap < 0) {
    return `Up ${Math.round(lead * 10) / 10}, but they have ${Math.abs(leftGap)} more still to play. Not as safe as it looks.`;
  }
  if (p > 0.85) return "Comfortable. Barring a disaster this is yours.";
  if (p < 0.15) return "Needs something unusual to happen.";
  return "Genuinely close — this comes down to the players still on the field.";
}

/**
 * Underdogs should chase ceiling, favourites should protect floor. Surfacing
 * this stops the app from recommending the "safe" play in a week where safe
 * loses 4 times out of 5.
 */
export function strategyAdvice(winProb) {
  if (winProb == null) return null;
  if (winProb < 0.35) {
    return {
      mode: "ceiling",
      text: "You're a clear underdog — take the high-ceiling player even at a lower projection. A safe lineup loses this matchup most weeks.",
    };
  }
  if (winProb > 0.68) {
    return {
      mode: "floor",
      text: "You're favoured — protect the floor. Avoid boom/bust starts; you win by not blowing up.",
    };
  }
  return { mode: "balanced", text: "Close matchup — start the highest projected points, variance barely matters here." };
}
