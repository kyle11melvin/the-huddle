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
//
// Players are NOT independent draws. A QB and his receivers rise and fall
// together (the stack), everyone in one NFL game shares its script, and a
// D/ST eats when the opposing offense starves. The sim models this with a
// factor structure (Gaussian copula over lognormal marginals): each NFL game
// and each offense gets a latent factor, players load onto them by position,
// and the leftover variance is player-specific. Marginals are unchanged —
// correlation only reshapes the JOINT outcomes, which is exactly what win
// probability cares about.
// ============================================================================

import { SLOT_DEFS } from "./lineup.js";
import { pointDistribution } from "./analytics.js";
import { LEAGUE_ROSTERS } from "./data/leagueRosters.js";
import { espnTeamRoster } from "./espnSync.js";
import { scheduleOpp } from "./scheduleSync.js";

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

// ------------------------------------------------------------- correlation ---

// Factor loadings by position. Chosen to land on the empirically reported
// ranges: QB↔his WR/TE ≈ +0.3, QB↔his RB ≈ +0.15, same-game opponents mildly
// positive (shootouts lift everyone), D/ST vs opposing offense ≈ −0.25.
// Directional like BASE_CV — refit from real game logs once the season runs.
const TEAM_LOAD = { QB: 0.55, WR: 0.5, TE: 0.5, RB: 0.22, K: 0.3 };
const DST_OPP_LOAD = -0.45; // D/ST rides the OPPOSING offense factor, inverted
const GAME_LOAD = 0.2;
const DST_GAME_LOAD = -0.15; // shootouts are bad for defenses

const cleanAbbr = (s) => {
  const a = (s || "").replace(/^@/, "").trim().toUpperCase();
  return a && a !== "BYE" ? a : null;
};

/**
 * Build a per-iteration generator of correlated standard normals for a set of
 * players (my side AND the opponent's, together — my WR and their D/ST can
 * share an NFL game). Players without team/opp info degrade gracefully to
 * independent draws.
 */
function correlatedNormals(dists, normal) {
  const meta = dists.map((d) => {
    const team = cleanAbbr(d.team);
    const opp = cleanAbbr(d.opp);
    const pos = d.pos || "";
    let wTeam = 0;
    let teamKey = null;
    if (pos === "D/ST") {
      if (opp) {
        wTeam = DST_OPP_LOAD;
        teamKey = opp;
      }
    } else if (team && TEAM_LOAD[pos]) {
      wTeam = TEAM_LOAD[pos];
      teamKey = team;
    }
    const gameKey = team && opp ? [team, opp].sort().join("|") : null;
    const wGame = gameKey ? (pos === "D/ST" ? DST_GAME_LOAD : GAME_LOAD) : 0;
    const wIdio = Math.sqrt(Math.max(0, 1 - wTeam * wTeam - wGame * wGame));
    return { wTeam, teamKey, wGame, gameKey, wIdio };
  });
  const teamKeys = [...new Set(meta.map((m) => m.teamKey).filter(Boolean))];
  const gameKeys = [...new Set(meta.map((m) => m.gameKey).filter(Boolean))];
  return () => {
    const t = {};
    for (const k of teamKeys) t[k] = normal();
    const g = {};
    for (const k of gameKeys) g[k] = normal();
    return meta.map(
      (m) =>
        m.wTeam * (m.teamKey ? t[m.teamKey] : 0) +
        m.wGame * (m.gameKey ? g[m.gameKey] : 0) +
        m.wIdio * normal()
    );
  };
}

/**
 * Fantasy scores are right-skewed and never negative → lognormal marginals
 * matched to the conditional mean/sd, fed by a correlated z. Injury risk is
 * bimodal: with prob playProb the player produces the distribution, otherwise
 * exactly zero (a Questionable tag is not a 23% haircut, it's a 23% chance of
 * a donut).
 */
function lognormTransform(d, rand) {
  const mean = d.condMean ?? d.mean;
  const playProb = d.playProb ?? 1;
  if (!(mean > 0) || playProb <= 0) return () => 0;
  const sd = d.sd || 0;
  const variance = Math.max(sd * sd, 1e-6);
  const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)));
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  if (playProb >= 1) return (z) => Math.exp(mu + sigma * z);
  return (z) => (rand() < playProb ? Math.exp(mu + sigma * z) : 0);
}

// ---------------------------------------------------------------- lineups ---

/** Opponent NFL team for a player this week, from the synced schedule. */
const nflOppOf = (state, team, week) => cleanAbbr(scheduleOpp(state, team, week));

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
      if (d) out.push({ id, name: p.name, team: p.team || null, pos: p.pos, opp: nflOppOf(state, p.team, week), ...d });
      else missing.push(p.name);
    }
  }
  return { dists: out, missing };
}

/** Sum of EXPECTED points (injury-priced means). */
export const sumMeans = (dists) => Math.round(dists.reduce((n, d) => n + d.mean, 0) * 10) / 10;

// ESPN's raw injury strings → play probability, for opponent rosters.
const OPP_PLAY_PROB = { QUESTIONABLE: 0.77, DOUBTFUL: 0.25, OUT: 0, INJURY_RESERVE: 0, SUSPENSION: 0 };
const CVS = { QB: 0.32, RB: 0.5, WR: 0.58, TE: 0.6, K: 0.42, "D/ST": 0.72 };

/**
 * The opponent side of any simulation, one canonical builder (Lab, optimizer
 * and Gameday all use this instead of three hand-rolled copies).
 * Live ESPN starters + projections when synced; static-roster rank estimates
 * as the offline fallback.
 */
export function opponentDistributions(state, week, oppTeamOverride) {
  const oppTeam = oppTeamOverride || (state.matchups && state.matchups[week] && state.matchups[week].oppTeam) || "";
  if (!oppTeam) return [];

  const live = espnTeamRoster(state, oppTeam);
  if (live) {
    return live
      .filter((e) => e.slot !== "BE" && e.slot !== "IR" && Number.isFinite(e.proj) && e.proj > 0)
      .map((e) => {
        const playProb = OPP_PLAY_PROB[e.injuryStatus] ?? 1;
        return {
          id: (e.name || "").toLowerCase().replace(/[^a-z]/g, ""),
          name: e.name,
          team: e.team || null,
          pos: e.pos,
          opp: nflOppOf(state, e.team, week),
          mean: Math.round(e.proj * playProb * 10) / 10,
          condMean: e.proj,
          sd: e.proj * (CVS[e.pos] ?? 0.55),
          playProb,
        };
      });
  }

  const oppRoster = LEAGUE_ROSTERS.find((t) => t.team === oppTeam);
  if (!oppRoster) return [];
  const out = [];
  for (const [name, team, pos] of oppRoster.starters) {
    const k = name.toLowerCase().replace(/[^a-z]/g, "");
    const rank = state.ecrIndex ? state.ecrIndex[k] : null;
    if (rank == null) continue;
    // Rough points-from-rank curve, only used to give the simulation an
    // opponent at all. Flagged as an estimate everywhere it surfaces.
    const mean = Math.max(4, 22 - Math.log2(Math.max(1, rank)) * 3.1);
    out.push({ id: k, name, team: team || null, pos, opp: nflOppOf(state, team, week), mean, sd: mean * (CVS[pos] ?? 0.55) });
  }
  return out;
}

// -------------------------------------------------------------- simulation ---

/**
 * @returns {{winProb, myMean, oppMean, myP10, myP90, margin}|null}
 */
export function simulateMatchup(myDists, oppDists, seed = 12345, runs = RUNS) {
  if (!myDists.length || !oppDists.length) return null;
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);

  // One factor context across BOTH lineups — my WR and their D/ST can be in
  // the same NFL game, and that anti-correlation is real win-prob signal.
  const all = [...myDists, ...oppDists];
  const zGen = correlatedNormals(all, normal);
  const fns = all.map((d) => lognormTransform(d, rand));
  const nMine = myDists.length;

  let wins = 0;
  const totals = new Array(runs);
  let marginSum = 0;
  for (let i = 0; i < runs; i++) {
    const z = zGen();
    let a = 0;
    for (let j = 0; j < nMine; j++) a += fns[j](z[j]);
    let b = 0;
    for (let j = nMine; j < all.length; j++) b += fns[j](z[j]);
    totals[i] = a;
    marginSum += a - b;
    if (a > b) wins++;
  }
  totals.sort((x, y) => x - y);
  const pct = (q) => Math.round(totals[Math.floor(q * (runs - 1))] * 10) / 10;

  return {
    winProb: wins / runs,
    myMean: sumMeans(myDists),
    oppMean: sumMeans(oppDists),
    myP10: pct(0.1),
    myP90: pct(0.9),
    margin: Math.round((marginSum / runs) * 10) / 10,
  };
}

/**
 * Win probability if `inId` started in place of `outId`.
 * This is the number that actually answers "who should I start".
 */
export function simulateSwap(state, week, oppDists, outId, inId, seed = 12345, runs = RUNS) {
  const base = lineupDistributions(state, state.lineup, week);
  const swapped = base.dists.filter((d) => d.id !== outId);
  const p = state.players[inId];
  if (!p) return null;
  const d = pointDistribution(p, week, state);
  if (!d) return null;
  swapped.push({ id: inId, name: p.name, team: p.team || null, pos: p.pos, opp: nflOppOf(state, p.team, week), ...d });

  const before = simulateMatchup(base.dists, oppDists, seed, runs);
  const after = simulateMatchup(swapped, oppDists, seed, runs);
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
 *   not started → their full projected distribution (× play probability if
 *                 they carry a Q/D tag)
 *   in progress → what they've banked, plus the fraction of their projection
 *                 still to come. Variance scales with sqrt(remaining) because
 *                 a player with a quarter left is far more predictable than
 *                 one at kickoff.
 *
 * Correlation applies to the UNPLAYED portions through the same factor
 * structure as the pre-game sim; banked points are facts and carry none.
 *
 * @param {Array} sides [{proj, scored, pctRemaining, status, cv, team, opp, pos, playProb}]
 */
function liveParts(entries, rand) {
  return entries.map((e) => {
    const scored = Number.isFinite(e.scored) ? e.scored : 0;
    if (e.status === "final") return { fixed: scored };

    const remainingFrac = e.status === "inProgress" ? Math.max(0, Math.min(1, e.pctRemaining ?? 0)) : 1;
    const remainingMean = Math.max(0, (e.proj || 0) * remainingFrac);
    if (remainingMean <= 0) return { fixed: scored };

    const cv = e.cv ?? 0.55;
    // Full-game sd shrunk by sqrt of the fraction still to be played.
    const sd = (e.proj || 0) * cv * Math.sqrt(remainingFrac);
    const variance = Math.max(sd * sd, 1e-6);
    const sigma = Math.sqrt(Math.log(1 + variance / (remainingMean * remainingMean)));
    const mu = Math.log(remainingMean) - (sigma * sigma) / 2;
    // A Q/D tag only matters before kickoff — a player already on the field
    // has resolved his coin flip.
    const playProb = e.status === "notStarted" ? e.playProb ?? 1 : 1;
    return { scored, mu, sigma, playProb, rand };
  });
}

export function simulateLive(myEntries, oppEntries, seed = 991) {
  if (!myEntries.length || !oppEntries.length) return null;
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);

  const all = [...myEntries, ...oppEntries];
  const zGen = correlatedNormals(all, normal);
  const parts = liveParts(all, rand);
  const nMine = myEntries.length;

  const draw = (part, z) => {
    if (part.fixed != null) return part.fixed;
    if (part.playProb < 1 && rand() >= part.playProb) return part.scored;
    return part.scored + Math.exp(part.mu + part.sigma * z);
  };

  let wins = 0;
  let ties = 0;
  const totals = new Array(RUNS);
  const oppTotals = new Array(RUNS);
  for (let i = 0; i < RUNS; i++) {
    const z = zGen();
    let a = 0;
    for (let j = 0; j < nMine; j++) a += draw(parts[j], z[j]);
    let b = 0;
    for (let j = nMine; j < all.length; j++) b += draw(parts[j], z[j]);
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
