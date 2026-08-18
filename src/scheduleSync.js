// ============================================================================
// Schedule client: opponents-by-week and auto byes, plus the cross-roster
// "who else needs this position" check that turns waiver suggestions from a
// list into intel.
// ============================================================================

import { resolveByes } from "./lineup.js";

export async function fetchSchedule() {
  const base = import.meta.env.DEV ? "https://the-huddle-hq.vercel.app" : "";
  const r = await fetch(`${base}/api/schedule`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Schedule endpoint returned ${r.status}`);
  return r.json();
}

/**
 * Store the schedule and derive byes from it. Manual bye entries win —
 * someone correcting the feed shouldn't be overridden by it.
 */
export function applySchedule(state, data) {
  if (!data || !data.complete) {
    // A partial schedule silently marking players "on bye" would be worse
    // than no schedule; keep whatever exists and say nothing.
    return { state, skipped: true };
  }
  // Numeric byes only (storage-boundary rule).
  const clean = {};
  for (const [team, w] of Object.entries(data.byes || {})) {
    const n = parseInt(w, 10);
    if (n >= 1 && n <= 18) clean[team] = n;
  }
  // Auto values are REPLACED wholesale, and only genuinely-manual entries
  // layer on top. Merging the previous effective map back over the fresh one
  // (the old `{ ...clean, ...state.byes }`) meant any bad auto value shadowed
  // every future correct fetch forever, because it looked like a human's.
  const byesAuto = clean;
  const byesManual = state.byesManual || {};
  const byes = resolveByes(byesAuto, byesManual);
  return {
    state: {
      ...state,
      byes,
      byesAuto,
      byesManual,
      schedule: { opps: data.opps, fetchedAt: data.fetchedAt, season: data.season },
    },
    byeCount: Object.keys(byes).length,
  };
}

/** Opponent string for a team in a week — manual per-player entry wins upstream. */
export function scheduleOpp(state, teamAbbr, week) {
  return (state.schedule && state.schedule.opps?.[String(week)]?.[teamAbbr]) || "";
}

/** The next N opponents from a given week, e.g. ["@PIT", "TB", "BYE", "@NO"]. */
export function nextOpponents(state, teamAbbr, fromWeek, n = 3) {
  if (!state.schedule) return null;
  const start = Math.max(1, parseInt(fromWeek, 10) || 1);
  const out = [];
  for (let w = start; w < start + n && w <= 18; w++) {
    out.push(scheduleOpp(state, teamAbbr, w) || "BYE");
  }
  return out;
}

/**
 * Bye cliffs: weeks where several of your players sit out at once. Knowing
 * this three weeks early is exactly when waiver help is still cheap.
 */
export function byeCliffs(state, minPlayers = 3) {
  const byes = state.byes || {};
  const byWeek = {};
  for (const p of Object.values(state.players || {})) {
    const w = byes[p.team];
    if (!w) continue;
    (byWeek[w] = byWeek[w] || []).push(p.name);
  }
  return Object.entries(byWeek)
    .map(([week, players]) => ({ week: Number(week), players, cliff: players.length >= minPlayers }))
    .sort((a, b) => a.week - b.week);
}

/** Remaining games this season for an NFL team (bye-adjusted, from current week). */
export function rosWeeks(state, team) {
  if (!team) return 0;
  const cw = Math.max(1, parseInt(state.week, 10) || 1);
  let n = 0;
  for (let w = cw; w <= 17; w++) {
    if (state.byes && Number(state.byes[team]) === w) continue;
    if (state.schedule && !scheduleOpp(state, team, w)) continue;
    n++;
  }
  return n;
}

/**
 * Rest-of-season projection: weekly projection × remaining non-bye games.
 * A flat extrapolation, labeled as such — it answers "which of these two
 * players produces more from here", not "exactly how many points".
 */
export function rosPoints(state, team, weeklyProj) {
  if (!Number.isFinite(weeklyProj) || weeklyProj <= 0) return null;
  return Math.round(weeklyProj * rosWeeks(state, team));
}

// How many usable players a team needs per position before they're "thin".
const THIN_AT = { QB: 2, RB: 5, WR: 5, TE: 2, "D/ST": 1, K: 1 };

/**
 * Which OTHER fantasy teams are thin at a position, from the live rosters.
 * On a suggested add this answers the question FantasyPros can't: will
 * anyone outbid you? Their site doesn't know your league; we do.
 */
export function rosterCompetition(state, pos) {
  if (!state.espn) return null;
  const need = THIN_AT[pos] ?? 3;
  const budget = Number.isFinite(state.espn.leagueFaab) ? state.espn.leagueFaab : 100;
  const out = [];
  for (const t of state.espn.teams) {
    if (t.id === state.espn.myTeamId) continue;
    const count = t.roster.filter((e) => e.pos === pos).length;
    if (count < need) {
      // A thin rival with no budget left isn't a rival — remaining FAAB is
      // what turns "they need a WR" into "they can actually outbid you".
      const faabLeft = Number.isFinite(t.faabSpent) ? Math.max(0, budget - t.faabSpent) : null;
      out.push({ team: t.mapped, count, faabLeft });
    }
  }
  return out.sort((a, b) => a.count - b.count);
}
