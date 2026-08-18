// ============================================================================
// Watchlist intelligence.
//
// What the big sites give a watchlist: ESPN a plain list, FantasyPros a rank
// and SOS stars, Sleeper an add-trend arrow. None of them can answer the only
// questions that matter, because none of them know YOUR league and roster:
//
//   is he better than what I have?           (fit)
//   will someone outbid me?                  (competition)
//   does he play when my roster doesn't?     (bye coverage)
//   what should I actually bid?              (a number, not vibes)
//
// Every tracked player gets a computed TIER — the verdict — with the working
// shown underneath. All inputs are live-synced; nothing here is typed in.
// ============================================================================

import { positionNeeds, liveRankInfo } from "./analysis.js";
import { normName } from "./espnSync.js";
import { nextOpponents, byeCliffs, rosterCompetition, rosWeeks } from "./scheduleSync.js";
import { SLOT_DEFS, slotAccepts } from "./lineup.js";
import { pointDistribution } from "./analytics.js";

// ---------------------------------------------------------------- bidding ---
//
// The old formula was `3 + upgradeRanks * 1.2 + rivals * 6`, which priced a
// 1%-rostered player at $23 — a quarter of a season's budget for someone
// nobody in the league had claimed. Three things were wrong with it:
//
//   · % rostered was computed, displayed on the card, and never used. The
//     single best signal of what a player will actually COST was ignored.
//   · `rivals` (teams thin at the position) was an ADDEND, so positional
//     shape manufactured value even where no contest existed.
//   · Everything was denominated in rank distance, but what you buy is
//     points. Twelve ranks at WR22→WR34 is nothing; WR3→WR15 is real.
//
// So: price off projected points added over the man he'd actually replace,
// then let demand, contest, and season phase scale it.
//
// The right long-run currency is Δ playoff odds — "this add is worth 4% of
// making the playoffs" — but the rest-of-season sim doesn't exist yet.
// When it does, it replaces `pointsAdded` below and everything else stands.

/** Dollars per projected rest-of-season point added. Calibrated so a genuine
 *  season-long starter upgrade at real demand lands near a third of budget,
 *  not the whole thing. A heuristic, like everything else here. */
const DOLLARS_PER_ROS_POINT = 0.5;

/**
 * What the market will charge, from % rostered.
 * Deliberately brutal at the bottom: under ~10% owned nobody is bidding
 * against you, and the asymmetry is stark — underbid a player nobody wants
 * and he's still there next week; overbid and the budget is gone for good.
 */
export function demandFactor(owned) {
  if (!Number.isFinite(owned)) return 0.45; // unknown ownership — middling, not free
  return 0.12 + 1.2 / (1 + Math.exp(-(owned - 42) / 12));
}

/** Rival need SCALES a contested bid; it can no longer create one from nothing. */
export const thinnessFactor = (rivals) => 1 + 0.12 * Math.min(rivals, 4);

/**
 * Early FAAB is precious (it buys optionality for the whole season); late
 * FAAB expires unused, so spend it. Note this partly offsets the shrinking
 * rest-of-season window, which is the intended behaviour rather than an
 * accident: a week-11 add helps for 3 weeks but the money is worthless after.
 */
export function phaseFactor(week) {
  const w = parseInt(week, 10);
  if (!Number.isFinite(w)) return 0.8; // preseason
  if (w <= 3) return 0.8;
  if (w <= 8) return 1.0;
  if (w <= 12) return 1.15;
  return 1.3;
}

/**
 * Price a claim.
 * @returns {{bid:number, why:string[]}} bid in dollars, plus the working.
 */
export function priceBid({ pointsAdded, owned, rivals = 0, week, faab = 0, handcuffFor = null }) {
  const why = [];
  const pts = Math.max(0, pointsAdded || 0);
  const demand = demandFactor(owned);
  const thin = thinnessFactor(rivals);
  const phase = phaseFactor(week);
  // Heuristic, and labelled as one: same NFL team + same position as a
  // valuable starter of yours. There's no depth-chart feed behind this — it
  // prices the live branch where the starter goes down, nothing more.
  const handcuff = handcuffFor ? 1.5 : 1;

  let bid = pts * DOLLARS_PER_ROS_POINT * demand * thin * phase * handcuff;

  if (pts <= 0) why.push("no projected upgrade over your current starter");
  else why.push(`+${Math.round(pts)} projected pts rest-of-season over your weakest ${"starter"}`);
  if (Number.isFinite(owned)) {
    why.push(
      owned < 10
        ? `only ${Math.round(owned)}% rostered — nobody is bidding against you`
        : owned >= 40
        ? `${Math.round(owned)}% rostered — expect real competition`
        : `${Math.round(owned)}% rostered`
    );
  } else why.push("ownership unknown — priced conservatively");
  if (rivals > 0) why.push(`${rivals} rival${rivals === 1 ? "" : "s"} thin at the position`);
  if (handcuffFor) why.push(`handcuff to ${handcuffFor} (heuristic: same team + position)`);

  // Never more than the budget, and never an all-in bid on a heuristic.
  const ceiling = Math.max(1, Math.min(faab, Math.round(faab * 0.5)));
  bid = Math.max(1, Math.min(Math.round(bid), ceiling));
  return { bid, why };
}

/** The weakest starter this player could legally replace, in projected points. */
export function weakestReplaceablePoints(state, week, pos) {
  let worst = null;
  for (const s of SLOT_DEFS) {
    if (!slotAccepts(s.key, pos)) continue;
    for (const id of state.lineup?.[s.key] || []) {
      // An EMPTY slot he could fill means replacement level is zero — every
      // point he scores is a point you weren't getting. Worth more, not less.
      if (!id) return 0;
      const p = state.players[id];
      if (!p) continue;
      const d = pointDistribution(p, week, state);
      const mean = d ? d.mean : 0;
      if (worst == null || mean < worst) worst = mean;
    }
  }
  return worst;
}

/** Heuristic handcuff: same NFL team and position as a valuable starter. */
export function handcuffTarget(state, week, team, pos, minStarterPoints = 14) {
  if (!team || !pos) return null;
  for (const s of SLOT_DEFS) {
    for (const id of state.lineup?.[s.key] || []) {
      if (!id) continue;
      const p = state.players[id];
      if (!p || p.team !== team || p.pos !== pos) continue;
      const d = pointDistribution(p, week, state);
      if (d && d.mean >= minStarterPoints) return p.name;
    }
  }
  return null;
}

export const TIERS = {
  priority: { label: "PRIORITY ADD", icon: "🔥", tone: "red", blurb: "clear upgrade and others want him — bid like you mean it" },
  upgrade: { label: "UPGRADE", icon: "📈", tone: "good", blurb: "better than what you're rolling out — nobody else is hurting for the spot" },
  stash: { label: "STASH", icon: "🧊", tone: "blue", blurb: "not a starter today, but the profile says hold him before he costs real FAAB" },
  monitor: { label: "MONITOR", icon: "👀", tone: "dim", blurb: "watch, don't spend" },
  noteam: { label: "NO NFL TEAM", icon: "🚫", tone: "dim", blurb: "unsigned — can't score points until someone signs him" },
  rostered: { label: "TRADE TARGET", icon: "🤝", tone: "gold", blurb: "rostered in your league — this is a trade conversation, not a claim" },
};

/**
 * Full intel for one watchlist entry.
 * @param {object} state
 * @param {object} entry  watch item {name, team?, pos?}
 * @param {string|null} owner  fantasy team that rosters him, if any
 */
export function watchIntel(state, entry, owner) {
  const k = normName(entry.name);
  const pool = (state.espn && state.espn.pool) || [];
  const poolRec = pool.find((p) => normName(p.name) === k) || null;

  const team = (poolRec && poolRec.team) || entry.team || "";
  const pos = (poolRec && poolRec.pos) || entry.pos || "";
  const hasNflTeam = !!team;
  // No NFL team → no projection, no rank, no fit math. ESPN projects unsigned
  // veterans off last year's stats; showing "Tyreek Hill WR7, +27 better than
  // your WRs" for a player who can't take a snap is worse than showing nothing.
  const proj = hasNflTeam && poolRec && poolRec.proj > 0 ? poolRec.proj : null;
  const owned = poolRec ? poolRec.percentOwned : null;
  // Rank now carries its provenance — a projection-derived rank and a pasted
  // expert rank are different claims and used to render identically.
  const rankInfo = hasNflTeam ? liveRankInfo(state, { name: entry.name, ecr: entry.ecr }) : null;
  const rank = rankInfo ? rankInfo.rank : null;
  const week = state.week;
  const schedule = hasNflTeam ? nextOpponents(state, team, week, 3) : null;
  const byeWk = hasNflTeam ? Number(state.byes?.[team]) || null : null;

  // Does he play through a week where my roster craters?
  const cliffs = byeCliffs(state).filter((c) => c.cliff);
  const coveredCliffs = hasNflTeam
    ? cliffs.filter((c) => c.week !== byeWk).map((c) => c.week)
    : [];
  const collidingCliffs = hasNflTeam ? cliffs.filter((c) => c.week === byeWk).map((c) => c.week) : [];

  // Fit: how many position-ranks better than my group's standard at his slot.
  const needs = positionNeeds(state);
  const need = pos ? needs[pos] ?? null : null;
  const upgradeRanks = rank != null && need != null ? Math.round(need - rank) : null;
  const isUpgrade = upgradeRanks != null && upgradeRanks > 0;

  const rivals = pos ? rosterCompetition(state, pos) || [] : [];
  // Only rivals who can still pay count as competition. Unknown budget
  // (pre-sync) is treated as live — conservative beats wrong.
  const liveRivals = rivals.filter((r) => r.faabLeft == null || r.faabLeft >= 3);
  const richestRival = liveRivals.reduce(
    (max, r) => (r.faabLeft != null && (max == null || r.faabLeft > max) ? r.faabLeft : max),
    null
  );

  // ---- verdict ----
  let tier;
  if (owner) tier = "rostered";
  else if (!hasNflTeam) tier = "noteam";
  else if (isUpgrade && liveRivals.length > 0) tier = "priority";
  else if (isUpgrade) tier = "upgrade";
  else if ((owned != null && owned < 60 && coveredCliffs.length > 0) || (upgradeRanks != null && upgradeRanks > -8))
    tier = "stash";
  else tier = "monitor";

  // ---- suggested opening bid ----
  // Priced in POINTS ADDED, gated by actual demand. See priceBid above for
  // why the old rank-distance formula was wrong.
  let bid = null;
  let bidWhy = [];
  const replaces = hasNflTeam && pos ? weakestReplaceablePoints(state, week, pos) : null;
  const handcuffFor = hasNflTeam ? handcuffTarget(state, week, team, pos) : null;
  const weeksLeft = hasNflTeam ? rosWeeks(state, team) : 0;
  const pointsAdded =
    proj != null && replaces != null ? Math.max(0, proj - replaces) * Math.max(1, weeksLeft) : 0;

  if (!owner && hasNflTeam && (tier === "priority" || tier === "upgrade" || tier === "stash")) {
    const priced = priceBid({
      pointsAdded,
      owned,
      rivals: liveRivals.length,
      week,
      faab: state.faab || 0,
      handcuffFor,
    });
    bid = priced.bid;
    bidWhy = priced.why;
    // Never outbid the richest funded rival by more than a dollar when every
    // rival's budget is known — you can't lose to someone who can't pay.
    if (richestRival != null && liveRivals.length > 0 && liveRivals.every((r) => r.faabLeft != null)) {
      const capped = Math.max(1, Math.min(bid, richestRival + 1));
      if (capped < bid) bidWhy.push(`capped at $${capped} — the richest rival can only spend $${richestRival}`);
      bid = capped;
    }
  }

  return {
    tier,
    ...TIERS[tier],
    team,
    pos,
    proj,
    owned,
    rank,
    rankSource: rankInfo ? rankInfo.source : null,
    pointsAdded: Math.round(pointsAdded),
    replacesPoints: replaces,
    handcuffFor,
    bidWhy,
    upgradeRanks,
    schedule,
    byeWk,
    coveredCliffs,
    collidingCliffs,
    rivals,
    liveRivals,
    bid,
    synced: !!poolRec,
  };
}

/** Sort order for the watchlist: hottest verdicts first, then by rank. */
const TIER_ORDER = { priority: 0, upgrade: 1, stash: 2, rostered: 3, monitor: 4, noteam: 5 };

export function sortWatchByIntel(entries, intelById) {
  return [...entries].sort((a, b) => {
    const ia = intelById[a.id];
    const ib = intelById[b.id];
    const t = (TIER_ORDER[ia?.tier] ?? 9) - (TIER_ORDER[ib?.tier] ?? 9);
    if (t !== 0) return t;
    return (ia?.rank ?? 999) - (ib?.rank ?? 999);
  });
}
