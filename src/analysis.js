// ============================================================================
// Derived analysis: bye weeks, lineup warnings, start/sit suggestions,
// positional strength, and trade angles.
//
// Nothing here invents data. Bye weeks are whatever you enter (the 2026 NFL
// bye schedule is not baked in — an invented one would quietly start a player
// on bye, which is worse than showing nothing). League-wide positional ranks
// require a pasted ranking set; until then the app says so instead of guessing.
// ============================================================================

import { SLOT_DEFS, findLocation, slotAccepts, POSITIONS } from "./lineup.js";
import { LEAGUE_ROSTERS, MY_TEAM, whoRosters } from "./data/leagueRosters.js";
import { pointDistribution } from "./analytics.js";

/** "RB6" -> {pos:"RB", rank:6}; "DST9" -> {pos:"D/ST", rank:9} */
export function parseEcr(ecr) {
  const m = /^([A-Za-z/]+?)(\d+)$/.exec((ecr || "").trim());
  if (!m) return null;
  let pos = m[1].toUpperCase();
  if (pos === "DST") pos = "D/ST";
  return { pos, rank: parseInt(m[2], 10) };
}

export const ecrRank = (p) => parseEcr(p?.ecr)?.rank ?? null;

// ------------------------------------------------------------------- byes ---

export function byeWeekFor(byes, team) {
  const w = byes?.[team];
  return w === 0 || w == null || w === "" ? null : String(w);
}

export function isOnBye(player, week, byes) {
  if (!player || !week) return false;
  return byeWeekFor(byes, player.team) === String(week);
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

/** Higher is better. Unusable players score -Infinity so they never start.
 *  Live projections (props > ESPN, vegas-tilted) are the primary scale so the
 *  optimizer and the Start/Sit Lab can never disagree; the preseason rank
 *  scale only survives as an offline fallback. */
function scorePlayer(p, week, byes, state) {
  if (!p) return -Infinity;
  if (isUnusable(p, week, byes)) return -Infinity;
  const st = effectiveStatus(p, week, byes);
  const penalty = st === "D" ? 12 : st === "Q" ? 4 : 0;
  const dist = state ? pointDistribution(p, week, state) : null;
  if (dist) return dist.mean * 10 - penalty;
  const rank = ecrRank(p);
  const base = rank == null ? 0 : 200 - rank;
  const wd = (p.weeks && p.weeks[week]) || {};
  return base + (wd.matchup || 0) * 4 - penalty;
}

/**
 * Greedy optimal lineup. Slots are filled most-restrictive first so FLEX takes
 * whatever is left rather than stealing a player a dedicated slot needed.
 */
export function suggestLineup(state, week) {
  const byes = state.byes || {};
  const pool = [];
  for (const s of SLOT_DEFS) for (const id of state.lineup[s.key]) if (id) pool.push(id);
  for (const id of state.bench) if (id) pool.push(id);

  const order = ["QB", "D/ST", "K", "TE", "RB", "WR", "FLEX"];
  const slots = [];
  for (const key of order) {
    const def = SLOT_DEFS.find((s) => s.key === key);
    for (let i = 0; i < def.count; i++) slots.push({ key, index: i });
  }

  const used = new Set();
  const best = {};
  for (const slot of slots) {
    let pick = null;
    let pickScore = -Infinity;
    for (const id of pool) {
      if (used.has(id)) continue;
      const p = state.players[id];
      if (!p || !slotAccepts(slot.key, p.pos)) continue;
      const sc = scorePlayer(p, week, byes, state);
      if (sc > pickScore) {
        pickScore = sc;
        pick = id;
      }
    }
    if (pick && pickScore > -Infinity) {
      used.add(pick);
      best[`${slot.key}:${slot.index}`] = pick;
    }
  }

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
    moves.push({
      slotKey: o.slotKey,
      index: o.index,
      inId: cand,
      outId: o.id,
      inName: inP?.name,
      outName: outP?.name || null,
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
  return moves;
}

// ------------------------------------------------------- positional profile ---

/** Your ECR ranks per position, best first. Always available. */
export function myProfile(state) {
  const byPos = {};
  for (const p of Object.values(state.players)) {
    const loc = findLocation(state, p.id);
    if (!loc || loc.zone === "ir") continue;
    (byPos[p.pos] = byPos[p.pos] || []).push({ name: p.name, rank: ecrRank(p) });
  }
  for (const k of Object.keys(byPos)) {
    byPos[k].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  }
  return byPos;
}

/**
 * True league-wide positional rank. Requires an ECR index covering other
 * teams' players (populated by pasting a ranking set). Returns null when
 * there isn't enough data — the UI says so rather than inventing a number.
 */
export function leagueStrength(state) {
  // ESPN-projection auto-ranks give full coverage on their own; pasted
  // expert ranks override name-by-name where present.
  const index = { ...((state.espn && state.espn.autoRanks) || {}), ...(state.ecrIndex || {}) };
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
  const lookup = (name) => index[norm(name)] ?? null;

  // How many opponent players we can actually rank
  let known = 0;
  let total = 0;
  for (const t of LEAGUE_ROSTERS) {
    if (t.team === MY_TEAM) continue;
    for (const g of [t.starters, t.bench]) {
      for (const [name] of g || []) {
        total++;
        if (lookup(name) != null) known++;
      }
    }
  }
  const coverage = total ? known / total : 0;
  if (coverage < 0.5) return { ready: false, coverage, known, total };

  // Starter-weighted score per position: sum of (200 - rank) over the top N
  const DEPTH = { QB: 1, RB: 3, WR: 4, TE: 1, "D/ST": 1, K: 1 };
  const scoreTeam = (t) => {
    const byPos = {};
    for (const g of [t.starters, t.bench]) {
      for (const [name, , pos] of g || []) {
        const r = lookup(name);
        (byPos[pos] = byPos[pos] || []).push(r == null ? 999 : r);
      }
    }
    const out = {};
    for (const pos of POSITIONS) {
      const ranks = (byPos[pos] || []).sort((a, b) => a - b).slice(0, DEPTH[pos] || 1);
      out[pos] = ranks.reduce((n, r) => n + Math.max(0, 200 - r), 0);
    }
    return out;
  };

  const scored = LEAGUE_ROSTERS.map((t) => ({ team: t.team, ...scoreTeam(t) }));
  const ranks = {};
  for (const pos of POSITIONS) {
    const sorted = [...scored].sort((a, b) => b[pos] - a[pos]);
    ranks[pos] = {
      rank: sorted.findIndex((s) => s.team === MY_TEAM) + 1,
      of: sorted.length,
      order: sorted.map((s) => s.team),
    };
  }
  return { ready: true, coverage, ranks, scored };
}

/**
 * Trade angles: positions where you're deep and someone else is thin, paired
 * with the reverse. Uses league strength when available, roster counts as a
 * fallback so it degrades to something useful rather than nothing.
 */
export function tradeAngles(state) {
  const strength = leagueStrength(state);
  if (!strength.ready) return { ready: false };

  const mine = strength.ranks;
  const strong = POSITIONS.filter((p) => mine[p].rank <= 3);
  const weak = POSITIONS.filter((p) => mine[p].rank >= Math.ceil(mine[p].of * 0.7));

  const partners = [];
  for (const t of strength.scored) {
    if (t.team === MY_TEAM) continue;
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
 * How weak each position group is: average ECR of the players you'd actually
 * start there (missing depth counts as rank 250, i.e. "nobody"). Higher =
 * needier. Works from your roster alone, so it functions before any league-
 * wide data is pasted.
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
 * excluding anyone already on your roster.
 */
export function classifyAvailability(candidates, state) {
  const mine = new Set(Object.values(state.players).map((p) => p.name.toLowerCase()));
  const available = [];
  const taken = [];
  for (const c of candidates) {
    if (mine.has(c.name.toLowerCase())) continue;
    const owner = whoRosters(c.name);
    if (owner) taken.push({ ...c, owner });
    else available.push(c);
  }
  return { available, taken };
}
