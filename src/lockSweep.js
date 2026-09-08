// ============================================================================
// Lock sweep — the pre-kickoff checklist for a league with Lineup Protection
// OFF. Every slot locks at its OWN player's kickoff (seven at once Sunday
// morning), NFL inactives drop 90 minutes before, and an inactive starter
// scores zero with no auto-swap. This module finds the starters still worth
// acting on, soonest lock first.
//
// PURE and READ-ONLY on purpose: no network, no DOM, no app state, and it
// never proposes a lineup WRITE — a wrong automatic swap is worse than a
// missed manual one. It only reports.
//
// Two failure modes are treated as the design constraints, not edge cases:
//   - Everything keys on player ID, never name. Duplicate-name merging has
//     already shipped as a bug here once (see espnSync resolveExisting).
//   - A missing kickoff time must NOT drop an alert. Silently hiding a
//     genuinely OUT starter because a timestamp didn't arrive is the worst
//     outcome this module can produce, so unknown kickoffs are kept and
//     flagged — and sorted FIRST, because an unknown lock can't be ruled out
//     as imminent.
// ============================================================================

import { SLOT_DEFS, slotAccepts } from "./lineup.js";

// App-normalized statuses (see lineup.js STATUSES). ESPN's OUT and SUSPENSION
// both arrive as "O" via the espnSync INJURY map, so "O" covers suspensions.
const RISK_BY_STATUS = { O: "out", IR: "out", D: "high", Q: "watch" };

// Ties on lock time break by how certainly the slot scores zero.
const SEVERITY = { out: 0, empty: 1, bye: 2, high: 3, watch: 4 };

const parseTime = (v) => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Has this team's game kicked off, and when does/did it?
 * "Locked" needs PROOF — a live/final game state, or a parseable startTime in
 * the past. No data is never proof, in either direction: an unknown kickoff
 * doesn't exclude a starter (see header) and doesn't disqualify a bench
 * replacement either.
 */
function gameLock(games, team, nowMs) {
  const g = (games && team && games[team]) || null;
  const locksAt = g ? parseTime(g.startTime) : null;
  const locked = !!g && (g.state === "in" || g.state === "post" || (locksAt != null && nowMs >= locksAt));
  return { locked, locksAt };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Bench-only replacement candidates for one slot: eligible for the slot, not
 * on bye, not OUT/IR, own game not provably kicked off. Top 2 by projection.
 * `delta` is bench proj minus what the slot currently projects (0 for an
 * empty slot); null when a projection is missing rather than a made-up 0.
 */
function replacementsFor(slotKey, starterId, ctx) {
  const { bench, players, byes, weekNum, games, nowMs, projections } = ctx;
  const candidates = [];
  for (const id of bench) {
    const b = id ? players[id] : null;
    if (!b || !slotAccepts(slotKey, b.pos)) continue;
    const st = b.status || "";
    if (st === "O" || st === "IR") continue;
    if (st === "BYE" || (weekNum != null && byes[b.team] === weekNum)) continue;
    if (gameLock(games, b.team, nowMs).locked) continue;
    const proj = Number.isFinite(projections[id]) ? projections[id] : null;
    candidates.push({ id, name: b.name, pos: b.pos, team: b.team, status: st, proj });
  }
  candidates.sort((a, b) => (b.proj ?? -Infinity) - (a.proj ?? -Infinity));
  const base = starterId == null ? 0 : Number.isFinite(projections[starterId]) ? projections[starterId] : null;
  return candidates.slice(0, 2).map((r) => ({
    ...r,
    delta: r.proj != null && base != null ? round1(r.proj - base) : null,
  }));
}

/**
 * Sweep the starting lineup for slots worth acting on before they lock.
 *
 * @param {Object} args
 * @param {Object} args.roster  { lineup, bench, players, byes, week, projections }
 *   — the app's own shapes: lineup slotKey -> [id|null], bench [id|null],
 *   players id -> {id, name, team, pos, status}, byes team -> week number,
 *   projections id -> expected points (optional, drives replacement sorting).
 * @param {Object} args.games   team abbr -> { state, startTime } (the
 *   state.espn.games snapshot shape).
 * @param {number|Date} args.now
 * @returns {Array} alerts, soonest lock first:
 *   { id, slot, slotIndex, playerId, playerName, team, risk, locksAt,
 *     minutesToLock, kickoffUnknown, replacements }
 *   risk: "out" | "high" | "watch" | "empty" | "bye". Healthy starters and
 *   already-locked players are excluded. Bye/empty rows have no kickoff at
 *   all, so minutesToLock is null WITHOUT the kickoffUnknown flag.
 */
export function buildLockSweep({ roster, games, now }) {
  const { lineup = {}, bench = [], players = {}, byes = {}, week, projections = {} } = roster || {};
  const nowMs = parseTime(now) ?? Date.now();
  const parsedWeek = parseInt(week, 10);
  const weekNum = Number.isFinite(parsedWeek) ? parsedWeek : null; // "PRE" has no byes
  const ctx = { bench, players, byes, weekNum, games, nowMs, projections };

  const out = [];
  for (const s of SLOT_DEFS) {
    const slotIds = lineup[s.key] || [];
    for (let i = 0; i < s.count; i++) {
      const id = slotIds[i] || null;
      const p = id ? players[id] : null;

      // A slot pointing at nobody scores zero exactly like an empty one.
      if (!p) {
        out.push({
          id: `lock-${s.key}:${i}-empty`,
          slot: s.key,
          slotIndex: i,
          playerId: null,
          playerName: null,
          team: null,
          risk: "empty",
          locksAt: null,
          minutesToLock: null,
          kickoffUnknown: false,
          replacements: replacementsFor(s.key, null, ctx),
        });
        continue;
      }

      const onBye = p.status === "BYE" || (weekNum != null && byes[p.team] === weekNum);
      const risk = RISK_BY_STATUS[p.status] || (onBye ? "bye" : null);
      if (!risk) continue; // healthy — excluded, not "low"

      // A bye team has no game this week: no kickoff exists, nothing to lock,
      // and its absence from the scoreboard is expected, not "unknown".
      if (risk === "bye") {
        out.push({
          id: `lock-${s.key}:${i}-${id}-bye`,
          slot: s.key,
          slotIndex: i,
          playerId: id,
          playerName: p.name,
          team: p.team,
          risk,
          locksAt: null,
          minutesToLock: null,
          kickoffUnknown: false,
          replacements: replacementsFor(s.key, id, ctx),
        });
        continue;
      }

      const { locked, locksAt } = gameLock(games, p.team, nowMs);
      if (locked) continue; // unactionable = noise

      out.push({
        id: `lock-${s.key}:${i}-${id}-${risk}`,
        slot: s.key,
        slotIndex: i,
        playerId: id,
        playerName: p.name,
        team: p.team,
        risk,
        locksAt,
        minutesToLock: locksAt != null ? Math.max(0, Math.floor((locksAt - nowMs) / 60000)) : null,
        kickoffUnknown: locksAt == null,
        replacements: replacementsFor(s.key, id, ctx),
      });
    }
  }

  // Soonest lock first. Unknown kickoffs lead — they can't be ruled out as
  // imminent. Bye/empty rows never lock, so they trail.
  const urgency = (a) => (a.kickoffUnknown ? -Infinity : a.locksAt != null ? a.locksAt : Infinity);
  out.sort((a, b) => urgency(a) - urgency(b) || SEVERITY[a.risk] - SEVERITY[b.risk]);
  return out;
}
