// ============================================================================
// Derived analysis: bye weeks, lineup warnings, start/sit suggestions,
// positional strength, and trade angles.
//
// Nothing here invents data. Bye weeks are whatever the schedule feed (or a
// manual entry) says. Rosters and ranks come from the live ESPN sync; the
// hand-transcribed leagueRosters snapshot and the pasted-ECR strings survive
// ONLY as offline fallbacks, because every league transaction makes them a
// little more wrong.
// ============================================================================

import { SLOT_DEFS, findLocation, slotAccepts, POSITIONS, bestLineupFrom } from "./lineup.js";
import { LEAGUE_ROSTERS, MY_TEAM } from "./data/leagueRosters.js";
import { pointDistribution, PLAY_PROB } from "./analytics.js";
import { normName } from "./espnSync.js";
import { lineupDistributions, simulateMatchup, rankToPoints } from "./simulate.js";
import { scheduleOpp } from "./scheduleSync.js";

const nflOpp = (state, team, week) => {
  const a = (scheduleOpp(state, team, week) || "").replace(/^@/, "").trim().toUpperCase();
  return a && a !== "BYE" ? a : null;
};

/** "RB6" -> {pos:"RB", rank:6}; "DST9" -> {pos:"D/ST", rank:9} */
export function parseEcr(ecr) {
  const m = /^([A-Za-z/]+?)(\d+)$/.exec((ecr || "").trim());
  if (!m) return null;
  let pos = m[1].toUpperCase();
  if (pos === "DST") pos = "D/ST";
  return { pos, rank: parseInt(m[2], 10) };
}

export const ecrRank = (p) => parseEcr(p?.ecr)?.rank ?? null;

// -------------------------------------------------------------- rank index ---

/**
 * THE rank vocabulary, one for the whole app: ESPN-projection auto-ranks give
 * full live coverage, pasted expert ranks override name-by-name where present.
 * (myProfile, positionNeeds, leagueStrength and the waiver views all read
 * this; the preseason ECR string on a player record is the last resort.)
 */
export function rankIndex(state) {
  return { ...((state.espn && state.espn.autoRanks) || {}), ...(state.ecrIndex || {}) };
}

/**
 * Where a rank came from. Three different things were being rendered
 * identically as "WR RANK #22":
 *
 *   espn  — position rank derived by sorting ESPN's own weekly projections.
 *           "22nd-highest projection among WRs", NOT a consensus.
 *   fp    — a pasted expert ranking set. Actual consensus.
 *   ecr   — the preseason ECR string on the player record (from seeds).
 *
 * They are not the same claim and shouldn't look the same.
 */
export const RANK_SOURCE_LABEL = {
  espn: "ESPN proj",
  fp: "expert consensus",
  ecr: "preseason ECR",
};
export const RANK_SOURCE_SHORT = { espn: "ESPN", fp: "FP", ecr: "ECR" };

/** Rank + provenance, resolved in the same priority order the app uses. */
export function liveRankInfo(state, player) {
  if (!player) return null;
  const k = normName(player.name);
  const pasted = state.ecrIndex && state.ecrIndex[k];
  if (pasted != null) return { rank: pasted, source: "fp" };
  const auto = state.espn && state.espn.autoRanks && state.espn.autoRanks[k];
  if (auto != null) return { rank: auto, source: "espn" };
  const seeded = ecrRank(player);
  return seeded != null ? { rank: seeded, source: "ecr" } : null;
}

/** Live position rank for a player, falling back to their pasted ECR string. */
export function liveRank(state, player) {
  const info = liveRankInfo(state, player);
  return info ? info.rank : null;
}

// ------------------------------------------------------------------- byes ---
// Byes are numbers everywhere (normalized at the storage boundary); comparing
// them as strings in one file and numbers in another once made "on bye"
// silently depend on which module asked.

export function byeWeekFor(byes, team) {
  const w = Number(byes?.[team]);
  return Number.isFinite(w) && w >= 1 ? w : null;
}

export function isOnBye(player, week, byes) {
  if (!player || !week) return false;
  const wk = Number(week); // "PRE" → NaN → never on bye
  return Number.isFinite(wk) && byeWeekFor(byes, player.team) === wk;
}

/**
 * Status as it should read for this week: an explicit injury tag wins,
 * otherwise a bye shows through.
 */
export function effectiveStatus(player, week, byes) {
  if (!player) return "";
  if (player.status) return player.status;
  return isOnBye(player, week, byes) ? "BYE" : "";
}

/** Players who cannot produce this week. */
export const isUnusable = (player, week, byes) => {
  const s = effectiveStatus(player, week, byes);
  return s === "O" || s === "IR" || s === "BYE";
};

// -------------------------------------------------------------- lineup QA ---

export function lineupWarnings(state, week) {
  const out = [];
  const byes = state.byes || {};
  for (const s of SLOT_DEFS) {
    state.lineup[s.key].forEach((id, i) => {
      if (!id) {
        out.push({ level: "error", slot: s.key, text: `${s.key} slot is empty.` });
        return;
      }
      const p = state.players[id];
      if (!p) return;
      const st = effectiveStatus(p, week, byes);
      if (st === "BYE") out.push({ level: "error", slot: s.key, text: `${p.name} is on bye this week.` });
      else if (st === "O" || st === "IR") out.push({ level: "error", slot: s.key, text: `${p.name} is ${st}.` });
      else if (st === "D") out.push({ level: "warn", slot: s.key, text: `${p.name} is doubtful.` });
      else if (st === "Q") out.push({ level: "info", slot: s.key, text: `${p.name} is questionable.` });
    });
  }
  return out;
}

/**
 * Higher is better. Unusable players score -Infinity so they never start.
 *
 * EVERY branch returns expected fantasy points × 10. That is the whole point:
 * the old fallback returned `200 - rank` (≈100–200) while the projection
 * branch returned points×10 (≈0–350), so an UNPROJECTED bench player
 * routinely outscored a projected starter and the optimizer confidently
 * recommended benching your best player.
 *
 * The distribution mean is already injury-priced (playProb × outcome); the
 * rank fallback applies the same play-probability multiplier rather than a
 * flat penalty, so Q/D means the same thing on both paths.
 */
function scorePlayer(p, week, byes, state) {
  if (!p) return -Infinity;
  if (isUnusable(p, week, byes)) return -Infinity;
  const dist = state ? pointDistribution(p, week, state) : null;
  if (dist) return dist.mean * 10;

  // No projection: estimate points from rank using the app's one rank→points
  // curve, so the result is directly comparable with the branch above.
  const rank = state ? liveRank(state, p) : ecrRank(p);
  if (rank == null) return 0;
  const st = effectiveStatus(p, week, byes);
  const playProb = PLAY_PROB[st] ?? 1;
  const wd = (p.weeks && p.weeks[week]) || {};
  // matchup grade is a small nudge in POINTS (was 4 rank-units per star)
  const points = rankToPoints(rank) * playProb + (wd.matchup || 0) * 0.4;
  return points * 10;
}

// Fewer runs than the headline sim: the optimizer scans dozens of candidate
// lineups, and at 8k runs the Monte Carlo noise (~±0.5%) sits safely under
// the 1% reporting threshold below.
const SCAN_RUNS = 8000;
const MIN_WIN_DELTA = 0.01;

/**
 * Optimal lineup. Two modes:
 *
 * With opponent distributions (the normal, synced case) it maximizes WIN
 * PROBABILITY: every legal starter↔bench substitution is simulated against
 * this week's actual opponent, so the ceiling/floor logic strategyAdvice
 * describes is what the optimizer executes — an underdog gets told to start
 * the volatile guy even at a lower projection.
 *
 * Without an opponent (offline) it falls back to greedy projected points.
 * Mandatory fixes (empty slot, player who can't play) surface in both modes.
 */
export function suggestLineup(state, week, oppDists = null) {
  const byes = state.byes || {};
  const pool = [];
  for (const s of SLOT_DEFS) for (const id of state.lineup[s.key]) if (id) pool.push(id);
  for (const id of state.bench) if (id) pool.push(id);

  // Same primitive the opponent side uses — one optimizer, two lineups.
  const { bySlot: best } = bestLineupFrom(
    pool.map((id) => ({
      id,
      pos: state.players[id]?.pos,
      score: scorePlayer(state.players[id], week, byes, state),
    }))
  );

  // Fantasy scoring only cares WHICH players start, not which RB sits in RB1
  // vs RB2. Diffing the sets (rather than each slot) keeps a pure rotation
  // from being reported as "start the RB16 over the RB6".
  const bestSet = new Set(Object.values(best));
  const outs = [];
  for (const s of SLOT_DEFS) {
    for (let i = 0; i < s.count; i++) {
      const id = state.lineup[s.key][i];
      if (!id) outs.push({ id: null, slotKey: s.key, index: i });
      else if (!bestSet.has(id)) outs.push({ id, slotKey: s.key, index: i });
    }
  }
  const startingNow = new Set();
  for (const s of SLOT_DEFS) for (const id of state.lineup[s.key]) if (id) startingNow.add(id);
  const ins = [...bestSet].filter((id) => !startingNow.has(id));

  const moves = [];
  const takenIns = new Set();
  // Fill empty slots first, then genuine upgrades.
  for (const o of [...outs].sort((a, b) => (a.id ? 1 : 0) - (b.id ? 1 : 0))) {
    const cand = ins.find(
      (id) => !takenIns.has(id) && slotAccepts(o.slotKey, state.players[id]?.pos)
    );
    if (!cand) continue;
    takenIns.add(cand);
    const inP = state.players[cand];
    const outP = o.id ? state.players[o.id] : null;
    const gain = scorePlayer(inP, week, byes, state) - scorePlayer(outP, week, byes, state);
    const projIn = pointDistribution(inP, week, state)?.mean;
    const projOut = outP ? pointDistribution(outP, week, state)?.mean : null;
    const mandatory = !outP || isUnusable(outP, week, byes);
    moves.push({
      slotKey: o.slotKey,
      index: o.index,
      inId: cand,
      outId: o.id,
      inName: inP?.name,
      outName: outP?.name || null,
      mandatory,
      reason: !outP
        ? "fills an empty slot"
        : isUnusable(outP, week, byes)
        ? `${outP.name} can't play (${effectiveStatus(outP, week, byes)})`
        : projIn != null && projOut != null
        ? `${projIn} proj over ${projOut}`
        : `${inP.ecr || "unranked"} over ${outP.ecr || "unranked"}`,
      gain: Number.isFinite(gain) ? Math.round(gain) : 999,
    });
  }
  moves.sort((a, b) => b.gain - a.gain);

  // ---- win-probability mode -------------------------------------------------
  if (!oppDists || !oppDists.length) return moves; // offline fallback: points

  const mandatoryMoves = moves.filter((m) => m.mandatory);
  const base = lineupDistributions(state, state.lineup, week);
  // Unusable starters contribute nothing; drop them so the baseline is honest.
  const baseDists = base.dists.filter((d) => !isUnusable(state.players[d.id], week, byes));
  if (!baseDists.length) return moves;

  const before = simulateMatchup(baseDists, oppDists, 12345, SCAN_RUNS);
  if (!before) return moves;

  const benchIds = state.bench.filter(Boolean).filter((id) => {
    const p = state.players[id];
    return p && !isUnusable(p, week, byes) && pointDistribution(p, week, state);
  });
  const claimedSlots = new Set(mandatoryMoves.map((m) => `${m.slotKey}:${m.index}`));
  const claimedIns = new Set(mandatoryMoves.map((m) => m.inId));

  const winMoves = [];
  for (const s of SLOT_DEFS) {
    for (let i = 0; i < s.count; i++) {
      if (claimedSlots.has(`${s.key}:${i}`)) continue;
      const outId = state.lineup[s.key][i];
      if (!outId) continue;
      const outP = state.players[outId];
      if (!outP || isUnusable(outP, week, byes)) continue;
      const outDist = pointDistribution(outP, week, state);
      if (!outDist) continue;

      for (const inId of benchIds) {
        if (claimedIns.has(inId)) continue;
        const inP = state.players[inId];
        if (!slotAccepts(s.key, inP.pos)) continue;
        const inDist = pointDistribution(inP, week, state);
        // A far-lower projection can still be the right start for an underdog,
        // but not INFINITELY lower — skip hopeless swaps to keep the scan fast.
        if (inDist.mean < outDist.mean - 6) continue;

        const swapped = baseDists
          .filter((d) => d.id !== outId)
          .concat([{ id: inId, name: inP.name, team: inP.team || null, pos: inP.pos, opp: nflOpp(state, inP.team, week), ...inDist }]);
        const after = simulateMatchup(swapped, oppDists, 12345, SCAN_RUNS);
        if (!after) continue;
        const delta = after.winProb - before.winProb;
        if (delta < MIN_WIN_DELTA) continue;
        winMoves.push({
          slotKey: s.key,
          index: i,
          inId,
          outId,
          inName: inP.name,
          outName: outP.name,
          mandatory: false,
          delta,
          reason: `+${(delta * 100).toFixed(1)}% win probability (${inDist.mean} vs ${outDist.mean} proj)`,
          gain: Math.round(delta * 1000),
        });
      }
    }
  }

  // Best swap per slot and per incoming player — no double-promising.
  winMoves.sort((a, b) => b.delta - a.delta);
  const seenSlot = new Set();
  const seenIn = new Set();
  const picked = [];
  for (const m of winMoves) {
    const sk = `${m.slotKey}:${m.index}`;
    if (seenSlot.has(sk) || seenIn.has(m.inId)) continue;
    seenSlot.add(sk);
    seenIn.add(m.inId);
    picked.push(m);
  }
  return [...mandatoryMoves, ...picked];
}

// ------------------------------------------------------- roster source ------

/**
 * Every roster in the league, from the live ESPN snapshot when synced (the
 * truth), else the hand-transcribed file (the fallback that ages).
 */
function allRosters(state) {
  if (state.espn && state.espn.teams && state.espn.teams.length) {
    return state.espn.teams.map((t) => ({
      team: t.mapped || t.name,
      mine: t.id === state.espn.myTeamId,
      players: (t.roster || [])
        .filter((e) => e.slot !== "IR")
        .map((e) => ({ name: e.name, pos: e.pos })),
    }));
  }
  return LEAGUE_ROSTERS.map((t) => ({
    team: t.team,
    mine: t.team === MY_TEAM,
    players: [...(t.starters || []), ...(t.bench || [])].map(([name, , pos]) => ({ name, pos })),
  }));
}

// ------------------------------------------------------- positional profile ---

/** Your live position ranks per position, best first. Always available. */
export function myProfile(state) {
  const byPos = {};
  for (const p of Object.values(state.players)) {
    const loc = findLocation(state, p.id);
    if (!loc || loc.zone === "ir") continue;
    const info = liveRankInfo(state, p);
    (byPos[p.pos] = byPos[p.pos] || []).push({
      name: p.name,
      rank: info ? info.rank : null,
      source: info ? info.source : null,
    });
  }
  for (const k of Object.keys(byPos)) {
    byPos[k].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  }
  return byPos;
}

/**
 * True league-wide positional rank, computed over the LIVE rosters. Needs
 * rank coverage of opponents' players (auto-ranks provide it after any sync);
 * returns ready:false rather than inventing numbers when coverage is thin.
 */
export function leagueStrength(state) {
  const index = rankIndex(state);
  const lookup = (name) => index[normName(name)] ?? null;
  const rosters = allRosters(state);
  const myName = (rosters.find((r) => r.mine) || {}).team || MY_TEAM;

  // How many opponent players we can actually rank
  let known = 0;
  let total = 0;
  for (const t of rosters) {
    if (t.mine) continue;
    for (const pl of t.players) {
      total++;
      if (lookup(pl.name) != null) known++;
    }
  }
  const coverage = total ? known / total : 0;
  if (coverage < 0.5) return { ready: false, coverage, known, total };

  // Starter-weighted score per position: sum of (200 - rank) over the top N
  const DEPTH = { QB: 1, RB: 3, WR: 4, TE: 1, "D/ST": 1, K: 1 };
  const scoreTeam = (t) => {
    const byPos = {};
    for (const pl of t.players) {
      const r = lookup(pl.name);
      (byPos[pl.pos] = byPos[pl.pos] || []).push(r == null ? 999 : r);
    }
    const out = {};
    for (const pos of POSITIONS) {
      const ranks = (byPos[pos] || []).sort((a, b) => a - b).slice(0, DEPTH[pos] || 1);
      out[pos] = ranks.reduce((n, r) => n + Math.max(0, 200 - r), 0);
    }
    return out;
  };

  const scored = rosters.map((t) => ({ team: t.team, mine: t.mine, ...scoreTeam(t) }));
  const ranks = {};
  for (const pos of POSITIONS) {
    const sorted = [...scored].sort((a, b) => b[pos] - a[pos]);
    ranks[pos] = {
      rank: sorted.findIndex((s) => s.mine || s.team === myName) + 1,
      of: sorted.length,
      order: sorted.map((s) => s.team),
    };
  }
  return { ready: true, coverage, ranks, scored, myName };
}

/**
 * Trade angles: positions where you're deep and someone else is thin, paired
 * with the reverse. Runs on the same live rosters as leagueStrength.
 */
export function tradeAngles(state) {
  const strength = leagueStrength(state);
  if (!strength.ready) return { ready: false };

  const mine = strength.ranks;
  const strong = POSITIONS.filter((p) => mine[p].rank <= 3);
  const weak = POSITIONS.filter((p) => mine[p].rank >= Math.ceil(mine[p].of * 0.7));

  const partners = [];
  for (const t of strength.scored) {
    if (t.mine || t.team === strength.myName) continue;
    const theirRankAt = (pos) => strength.ranks[pos].order.indexOf(t.team) + 1;
    const give = strong.filter((p) => theirRankAt(p) >= 7);
    const get = weak.filter((p) => theirRankAt(p) <= 4);
    if (give.length && get.length) {
      partners.push({ team: t.team, give, get });
    }
  }
  return { ready: true, strong, weak, partners };
}

// ------------------------------------------------------------- suggestions ---

/**
 * How weak each position group is: average live rank of the players you'd
 * actually start there (missing depth counts as rank 250, i.e. "nobody").
 * Higher = needier.
 */
export function positionNeeds(state) {
  const profile = myProfile(state);
  const DEPTH = { QB: 1, RB: 3, WR: 4, TE: 1, "D/ST": 1, K: 1 };
  const needs = {};
  for (const pos of POSITIONS) {
    const depth = DEPTH[pos] || 1;
    const top = (profile[pos] || []).map((x) => x.rank ?? 250).slice(0, depth);
    while (top.length < depth) top.push(250);
    needs[pos] = top.reduce((a, b) => a + b, 0) / depth;
  }
  return needs;
}

/**
 * How weak each position group is, in PROJECTED POINTS.
 *
 * Replaces the rank-averaging version above for anything that compares one
 * player against your group. The old one averaged ranks whose sources differ
 * per player — a player inside ESPN's top-350 pool resolves to a
 * projection-order rank, one outside it falls back to a preseason ECR string,
 * and a pasted expert set overrides some but not all. Averaging those is
 * adding numbers from three different scales, and then `upgradeRanks`
 * differenced that mixed average against a single-source rank.
 *
 * Points make the question moot rather than patching it: every entry is the
 * same unit, from the same choke point (pointDistribution), already
 * injury-and-bye priced. A missing player scores 0 — replacement level is
 * nothing, which is exactly what an empty slot is worth.
 */
export function positionNeedPoints(state, week) {
  const DEPTH = { QB: 1, RB: 3, WR: 4, TE: 1, "D/ST": 1, K: 1 };
  const byPos = {};
  for (const p of Object.values(state.players || {})) {
    const loc = findLocation(state, p.id);
    if (!loc || loc.zone === "ir") continue;
    const d = pointDistribution(p, week, state);
    (byPos[p.pos] = byPos[p.pos] || []).push(d ? d.mean : 0);
  }
  const needs = {};
  for (const pos of POSITIONS) {
    const depth = DEPTH[pos] || 1;
    const top = (byPos[pos] || []).sort((a, b) => b - a).slice(0, depth);
    while (top.length < depth) top.push(0); // no player = zero points, not "rank 250"
    needs[pos] = Math.round((top.reduce((a, b) => a + b, 0) / depth) * 10) / 10;
  }
  return needs;
}

/**
 * Waiver targets scored by fit to YOUR roster, not by raw rank — a mid WR is
 * worth more to a team that's 10th of 10 at WR than the best available K is.
 * Only players who would genuinely upgrade the position group are suggested.
 */
export function suggestAdds(state, available, limit = 6) {
  const strength = leagueStrength(state);
  const needs = positionNeeds(state);
  return available
    .filter((p) => p.rank != null)
    .map((p) => {
      const need = needs[p.pos] ?? 150;
      let reason;
      if (strength.ready && strength.ranks[p.pos]) {
        const r = strength.ranks[p.pos];
        reason = `your ${p.pos} group ranks ${r.rank} of ${r.of} in the league`;
      } else if (need >= 200) {
        reason = `you have almost no ranked ${p.pos} depth`;
      } else {
        reason = `your ${p.pos} starters average around #${Math.round(need)}`;
      }
      return { ...p, score: need - p.rank, reason, upgrade: p.rank < need };
    })
    .filter((p) => p.upgrade)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// -------------------------------------------------------- waiver availability ---

/**
 * Split a candidate pool into genuinely available vs rostered elsewhere,
 * excluding anyone already on your roster. Ownership comes from the live
 * ESPN rosters when synced; the static snapshot is the offline fallback.
 */
export function classifyAvailability(candidates, state) {
  const mine = new Set(Object.values(state.players).map((p) => normName(p.name)));
  const ownerIndex = new Map();
  for (const r of allRosters(state)) {
    if (r.mine) continue;
    for (const pl of r.players) ownerIndex.set(normName(pl.name), r.team);
  }
  const available = [];
  const taken = [];
  for (const c of candidates) {
    if (mine.has(normName(c.name))) continue;
    const owner = ownerIndex.get(normName(c.name)) || null;
    if (owner) taken.push({ ...c, owner });
    else available.push(c);
  }
  return { available, taken };
}
