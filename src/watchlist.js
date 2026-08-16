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

import { positionNeeds } from "./analysis.js";
import { normName } from "./espnSync.js";
import { nextOpponents, byeCliffs, rosterCompetition } from "./scheduleSync.js";

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
  const rank = hasNflTeam
    ? (state.ecrIndex && state.ecrIndex[k]) ??
      ((state.espn && state.espn.autoRanks && state.espn.autoRanks[k]) || null)
    : null;
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

  // ---- suggested opening bid (heuristic, shown as such) ----
  // Upgrade size sets the base, FUNDED rivals raise the price, and when every
  // rival's budget is known you never bid more than beats the richest one by
  // a dollar. Your own remaining FAAB caps everything.
  let bid = null;
  if (!owner && hasNflTeam && (tier === "priority" || tier === "upgrade")) {
    let base = 3 + Math.max(0, upgradeRanks) * 1.2 + liveRivals.length * 6;
    if (richestRival != null && liveRivals.every((r) => r.faabLeft != null)) {
      base = Math.min(base, richestRival + 1);
    }
    bid = Math.max(1, Math.min(Math.round(base), Math.round((state.faab || 0) * 0.45)));
  } else if (tier === "stash") {
    bid = Math.min(3, state.faab || 0);
  }

  return {
    tier,
    ...TIERS[tier],
    team,
    pos,
    proj,
    owned,
    rank,
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
