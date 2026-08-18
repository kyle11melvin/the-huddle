// ============================================================================
// Lineup rules engine + v2 state model.
//
// State shape (persisted under "huddle-data"):
// {
//   v: 2,
//   week: "PRE" | "1".."17",
//   players: { [id]: { id, name, team, pos, espnId, ecr, status, notes,
//                      weeks: { [weekKey]: { opp, matchup } } } },
//   lineup: { QB:[id|null], RB:[..x2], WR:[..x3], TE:[id], FLEX:[id],
//             "D/ST":[id], K:[id] },
//   bench: [id|null x6],
//   ir:    [id|null x2],
//   watch, calls, faab, claims
// }
//
// Player `notes` (scouting text) is carried through verbatim from seeds and is
// never rewritten by any function here.
// ============================================================================

import { SEED_STARTERS, SEED_BENCH, SEED_WATCH } from "./data/seeds.js";

export const SLOT_DEFS = [
  { key: "QB", count: 1, accepts: ["QB"] },
  { key: "RB", count: 2, accepts: ["RB"] },
  { key: "WR", count: 3, accepts: ["WR"] },
  { key: "TE", count: 1, accepts: ["TE"] },
  { key: "FLEX", count: 1, accepts: ["RB", "WR", "TE"] },
  { key: "D/ST", count: 1, accepts: ["D/ST"] },
  { key: "K", count: 1, accepts: ["K"] },
];

export const BENCH_SIZE = 6;
export const IR_SIZE = 2;
export const MAX_ROSTER = 16; // 10 starters + 6 bench; IR does not count
export const POS_LIMITS = { QB: 3, RB: 8, WR: 8, TE: 3, "D/ST": 3, K: 3 };
export const POSITIONS = ["QB", "RB", "WR", "TE", "D/ST", "K"];
export const STATUSES = ["", "Q", "D", "O", "IR", "BYE"];

export const WEEKS = ["PRE", ...Array.from({ length: 17 }, (_, i) => String(i + 1))];
export const weekLabel = (w) => (w === "PRE" ? "Preseason" : `Week ${w}`);
export const weekShort = (w) => (w === "PRE" ? "PRESEASON" : `WEEK ${w}`);

/** Seed data lives in the preseason bucket — matches the original artifact's badge. */
export const SEED_WEEK = "PRE";

// ---------------------------------------------------------------- helpers ---

/** Canonical position. Seeds encode it via slot/pos, or the ECR prefix for FLEX. */
export function derivePos(p) {
  if (p.pos) return p.pos;
  if (p.slot && p.slot !== "FLEX") return p.slot;
  const m = /^([A-Za-z/]+?)\d+$/.exec(p.ecr || "");
  if (m) {
    const raw = m[1].toUpperCase();
    if (raw === "DST" || raw === "D/ST") return "D/ST";
    if (POSITIONS.includes(raw)) return raw;
  }
  return "WR";
}

export function slotAccepts(slotKey, pos) {
  const def = SLOT_DEFS.find((s) => s.key === slotKey);
  return def ? def.accepts.includes(pos) : false;
}

/** Zone sizes are league settings, not constants — ESPN reports them in
 *  mSettings.rosterSettings.lineupSlotCounts and plenty of leagues run 7
 *  bench spots. The exported constants are the fallback, not the truth. */
export function emptyZones(benchSize = BENCH_SIZE, irSize = IR_SIZE) {
  const lineup = {};
  for (const s of SLOT_DEFS) lineup[s.key] = Array(s.count).fill(null);
  return {
    lineup,
    bench: Array(Math.max(1, benchSize)).fill(null),
    ir: Array(Math.max(0, irSize)).fill(null),
  };
}

// ------------------------------------------------------------ build/migrate ---

export function buildInitialState() {
  const { lineup, bench, ir } = emptyZones();
  const players = {};
  const cursor = {};

  const ingest = (p) => {
    const pos = derivePos(p);
    players[p.id] = {
      id: p.id,
      name: p.name,
      team: p.team,
      pos,
      espnId: p.espnId || "",
      ecr: p.ecr || "",
      status: p.status || "",
      notes: p.notes || "",
      weeks: { [SEED_WEEK]: { opp: p.opp || "", matchup: p.matchup || 0 } },
    };
    return pos;
  };

  for (const p of SEED_STARTERS) {
    ingest(p);
    const key = p.slot;
    cursor[key] = cursor[key] || 0;
    if (lineup[key] && cursor[key] < lineup[key].length) lineup[key][cursor[key]++] = p.id;
  }
  SEED_BENCH.forEach((p, i) => {
    ingest(p);
    if (i < bench.length) bench[i] = p.id;
  });

  return {
    v: 2,
    week: SEED_WEEK,
    players,
    lineup,
    bench,
    ir,
    watch: SEED_WATCH.map((w) => ({ ...w })),
    calls: [],
    faab: 100,
    claims: [],
    byes: {}, // team -> week, EFFECTIVE map (auto ∪ manual). What readers use.
    byesAuto: {}, // derived from the schedule feed; replaced wholesale each fetch
    byesManual: {}, // typed by a human; merged on top of byesAuto
    orphans: [], // players migrate couldn't place; surfaced, never deleted
    ecrIndex: {}, // normalized name -> rank, from pasted ranking sets
    analytics: {}, // playerId -> week -> { proj, dvp, ou, expertRanks, ... }
    matchups: {}, // week -> { oppTeam, live: { rowKey -> {scored, status, pctRemaining} } }
    espn: null, // latest /api/espn snapshot (rosters, projections, pairings)
    schedule: null, // full-season NFL opponents by week, from /api/schedule
    alertsDismissed: {}, // alertId -> timestamp; a changed fact makes a new id
  };
}

/** Accepts v1 (starters/bench arrays) or v2 and always returns a valid v2 state. */
export function migrate(raw) {
  if (!raw || typeof raw !== "object") return buildInitialState();

  if (raw.v === 2 && raw.players && raw.lineup) {
    const base = buildInitialState();
    // Never shrink a saved roster: if this league runs 7 bench spots, the
    // saved arrays say so and truncating here would orphan the 7th player.
    const { lineup, bench, ir } = emptyZones(
      Math.max(BENCH_SIZE, Array.isArray(raw.bench) ? raw.bench.length : 0),
      Math.max(IR_SIZE, Array.isArray(raw.ir) ? raw.ir.length : 0)
    );
    const players = {};
    for (const [id, p] of Object.entries(raw.players || {})) {
      if (!p || !p.name) continue;
      players[id] = {
        id,
        name: p.name,
        team: p.team || "",
        pos: POSITIONS.includes(p.pos) ? p.pos : derivePos(p),
        espnId: p.espnId || "",
        ecr: p.ecr || "",
        status: STATUSES.includes(p.status) ? p.status : "",
        notes: typeof p.notes === "string" ? p.notes : "",
        weeks: p.weeks && typeof p.weeks === "object" ? p.weeks : {},
      };
    }
    // ONE `used` set across every zone. A per-zone set let the same player
    // occupy a lineup slot AND a bench slot, which inflates rosterCounts
    // (blocking legal adds) and leaves a ghost behind on drop.
    const used = new Set();
    const place = (target, src) => {
      for (let i = 0; i < target.length; i++) {
        const id = Array.isArray(src) ? src[i] : null;
        if (id && players[id] && !used.has(id)) {
          target[i] = id;
          used.add(id);
        }
      }
    };
    for (const s of SLOT_DEFS) place(lineup[s.key], raw.lineup?.[s.key]);
    place(bench, raw.bench);
    place(ir, raw.ir);
    // An orphaned player takes a free bench slot. If there is none we KEEP
    // the record and report it — deleting silently cost the user their notes,
    // ECR and week history, and the next sync re-added the player as "new".
    // A state that predates the auto/manual bye split needs the one-time
    // discard below; one that's already been migrated does not.
    const legacyByes = raw.byesAuto === undefined;

    const orphans = [];
    for (const id of Object.keys(players)) {
      if (used.has(id)) continue;
      const free = bench.indexOf(null);
      if (free >= 0) {
        bench[free] = id;
        used.add(id);
      } else {
        orphans.push({ id, name: players[id].name });
      }
    }
    return {
      v: 2,
      week: WEEKS.includes(raw.week) ? raw.week : SEED_WEEK,
      players,
      lineup,
      bench,
      ir,
      watch: Array.isArray(raw.watch) ? raw.watch : base.watch,
      calls: Array.isArray(raw.calls) ? raw.calls : [],
      faab: typeof raw.faab === "number" ? raw.faab : 100,
      claims: Array.isArray(raw.claims) ? raw.claims : [],
      // Legacy states (no byesAuto field) kept auto and manual byes in ONE
      // map, so a phantom bye from a failed week fetch was indistinguishable
      // from a human correction and shadowed every later good fetch. Those
      // are discarded wholesale — only byesManual, which never existed in the
      // old schema, can be trusted as human. Already-migrated states keep
      // their auto map as-is.
      byes: resolveByes(legacyByes ? {} : raw.byesAuto, raw.byesManual),
      byesAuto: legacyByes ? {} : normalizeByes(raw.byesAuto),
      byesManual: normalizeByes(raw.byesManual && typeof raw.byesManual === "object" ? raw.byesManual : {}),
      ecrIndex: raw.ecrIndex && typeof raw.ecrIndex === "object" ? raw.ecrIndex : {},
      analytics: raw.analytics && typeof raw.analytics === "object" ? raw.analytics : {},
      matchups: raw.matchups && typeof raw.matchups === "object" ? raw.matchups : {},
      espn: raw.espn && typeof raw.espn === "object" ? raw.espn : null,
      // On the legacy upgrade ONLY, clear fetchedAt so the discarded byes are
      // repopulated now rather than after the 7-day staleness gate. Doing it
      // unconditionally would re-fetch the schedule on every page load.
      schedule:
        raw.schedule && typeof raw.schedule === "object"
          ? { ...raw.schedule, ...(legacyByes ? { fetchedAt: 0 } : {}) }
          : null,
      alertsDismissed: raw.alertsDismissed && typeof raw.alertsDismissed === "object" ? raw.alertsDismissed : {},
      orphans,
    };
  }

  // ---- v1 → v2 ----
  const { lineup, bench, ir } = emptyZones();
  const players = {};
  const cursor = {};
  const ingestV1 = (p) => {
    if (!p || !p.id || !p.name) return null;
    const pos = derivePos(p);
    players[p.id] = {
      id: p.id,
      name: p.name,
      team: p.team || "",
      pos,
      espnId: p.espnId || "",
      ecr: p.ecr || "",
      status: STATUSES.includes(p.status) ? p.status : "",
      notes: p.notes || "",
      weeks: { [SEED_WEEK]: { opp: p.opp || "", matchup: p.matchup || 0 } },
    };
    return pos;
  };

  const v1Starters = Array.isArray(raw.starters) ? raw.starters : SEED_STARTERS;
  const v1Bench = Array.isArray(raw.bench) ? raw.bench : SEED_BENCH;

  for (const p of v1Starters) {
    const pos = ingestV1(p);
    if (!pos) continue;
    const key = SLOT_DEFS.some((s) => s.key === p.slot) ? p.slot : null;
    if (key) {
      cursor[key] = cursor[key] || 0;
      if (cursor[key] < lineup[key].length) {
        lineup[key][cursor[key]++] = p.id;
        continue;
      }
    }
    const free = bench.indexOf(null);
    if (free >= 0) bench[free] = p.id;
  }
  for (const p of v1Bench) {
    const pos = ingestV1(p);
    if (!pos) continue;
    const free = bench.indexOf(null);
    if (free >= 0) bench[free] = p.id;
  }

  return {
    v: 2,
    week: SEED_WEEK,
    players,
    lineup,
    bench,
    ir,
    watch: Array.isArray(raw.watch) ? raw.watch : SEED_WATCH.map((w) => ({ ...w })),
    calls: Array.isArray(raw.calls) ? raw.calls : [],
    faab: typeof raw.faab === "number" ? raw.faab : 100,
    claims: Array.isArray(raw.claims) ? raw.claims : [],
    byes: resolveByes({}, raw.byesManual), // see v2 branch: auto byes never carry forward
    byesAuto: {},
    byesManual: normalizeByes(raw.byesManual && typeof raw.byesManual === "object" ? raw.byesManual : {}),
    ecrIndex: raw.ecrIndex && typeof raw.ecrIndex === "object" ? raw.ecrIndex : {},
    analytics: raw.analytics && typeof raw.analytics === "object" ? raw.analytics : {},
    matchups: raw.matchups && typeof raw.matchups === "object" ? raw.matchups : {},
    espn: raw.espn && typeof raw.espn === "object" ? raw.espn : null,
    schedule: raw.schedule && typeof raw.schedule === "object" ? raw.schedule : null,
    alertsDismissed: raw.alertsDismissed && typeof raw.alertsDismissed === "object" ? raw.alertsDismissed : {},
  };
}

// -------------------------------------------------------------- matchups ---

export function setMatchupOpponent(state, week, oppTeam) {
  const matchups = { ...(state.matchups || {}) };
  matchups[week] = { ...(matchups[week] || {}), oppTeam };
  return { ...state, matchups };
}

export function setLiveEntry(state, week, rowKey, patch) {
  const matchups = { ...(state.matchups || {}) };
  const board = { ...(matchups[week] || {}) };
  const live = { ...(board.live || {}) };
  live[rowKey] = { ...(live[rowKey] || {}), ...patch };
  // Entering a score for someone who hasn't been marked as playing implies
  // their game is underway — saves a step during a live Sunday.
  if (patch.scored != null && !live[rowKey].status) live[rowKey].status = "inProgress";
  board.live = live;
  matchups[week] = board;
  return { ...state, matchups };
}

// -------------------------------------------------------------- locations ---

/** @returns {{zone:'lineup'|'bench'|'ir', slotKey?:string, index:number}|null} */
export function findLocation(state, id) {
  if (!id) return null;
  for (const s of SLOT_DEFS) {
    const i = state.lineup[s.key].indexOf(id);
    if (i >= 0) return { zone: "lineup", slotKey: s.key, index: i };
  }
  const b = state.bench.indexOf(id);
  if (b >= 0) return { zone: "bench", index: b };
  const r = state.ir.indexOf(id);
  if (r >= 0) return { zone: "ir", index: r };
  return null;
}

function readZone(state, loc) {
  if (loc.zone === "lineup") return state.lineup[loc.slotKey][loc.index];
  return state[loc.zone][loc.index];
}

function writeZone(next, loc, id) {
  if (loc.zone === "lineup") next.lineup[loc.slotKey][loc.index] = id;
  else next[loc.zone][loc.index] = id;
}

function cloneZones(state) {
  const lineup = {};
  for (const s of SLOT_DEFS) lineup[s.key] = [...state.lineup[s.key]];
  return { ...state, lineup, bench: [...state.bench], ir: [...state.ir] };
}

export const sameLoc = (a, b) =>
  !!a && !!b && a.zone === b.zone && a.index === b.index && a.slotKey === b.slotKey;

/** Can this player legally occupy this destination (ignoring current occupant)? */
export function canOccupy(state, id, dest) {
  const p = state.players[id];
  if (!p) return { ok: false, reason: "Unknown player" };
  if (dest.zone === "bench") return { ok: true };
  if (dest.zone === "ir") {
    if (p.status !== "IR") return { ok: false, reason: "Only IR-flagged players can use an IR slot" };
    return { ok: true };
  }
  if (!slotAccepts(dest.slotKey, p.pos)) {
    return { ok: false, reason: `${dest.slotKey} slot doesn't accept a ${p.pos}` };
  }
  if (p.status === "IR") return { ok: false, reason: "IR-flagged players can't start" };
  return { ok: true };
}

/** All destinations this player could legally move to right now. */
export function legalDestinations(state, id) {
  const here = findLocation(state, id);
  const out = [];
  const consider = (dest) => {
    if (sameLoc(here, dest)) return;
    const mine = canOccupy(state, id, dest);
    if (!mine.ok) return;
    const occupant = readZone(state, dest);
    if (occupant && here) {
      const theirs = canOccupy(state, occupant, here);
      if (!theirs.ok) return; // swap would be illegal
    }
    out.push({ ...dest, occupantId: occupant || null });
  };
  for (const s of SLOT_DEFS) {
    for (let i = 0; i < s.count; i++) consider({ zone: "lineup", slotKey: s.key, index: i });
  }
  for (let i = 0; i < state.bench.length; i++) consider({ zone: "bench", index: i });
  for (let i = 0; i < state.ir.length; i++) consider({ zone: "ir", index: i });
  return out;
}

/** Move (or swap). @returns {{state, error?:string}} */
export function movePlayer(state, id, dest) {
  const here = findLocation(state, id);
  if (!here) return { state, error: "Player is not on the roster" };
  if (sameLoc(here, dest)) return { state };

  const mine = canOccupy(state, id, dest);
  if (!mine.ok) return { state, error: mine.reason };

  const occupant = readZone(state, dest);
  if (occupant) {
    const theirs = canOccupy(state, occupant, here);
    if (!theirs.ok) return { state, error: `Can't swap — ${theirs.reason.toLowerCase()}` };
  }

  const next = cloneZones(state);
  writeZone(next, dest, id);
  writeZone(next, here, occupant || null);
  return { state: next };
}

/** First free destination in a zone, or null. */
export function firstFree(state, zone) {
  if (zone === "bench") {
    const i = state.bench.indexOf(null);
    return i >= 0 ? { zone: "bench", index: i } : null;
  }
  if (zone === "ir") {
    const i = state.ir.indexOf(null);
    return i >= 0 ? { zone: "ir", index: i } : null;
  }
  return null;
}

/** First empty lineup slot this player legally fits, or null. */
export function firstEmptyLegalSlot(state, id) {
  for (const s of SLOT_DEFS) {
    for (let i = 0; i < s.count; i++) {
      if (state.lineup[s.key][i]) continue;
      const dest = { zone: "lineup", slotKey: s.key, index: i };
      if (canOccupy(state, id, dest).ok) return dest;
    }
  }
  return null;
}

// ------------------------------------------------------------- roster size ---

/** Counts exclude IR, which does not consume a roster spot. */
export function rosterCounts(state) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, "D/ST": 0, K: 0 };
  let total = 0;
  for (const s of SLOT_DEFS) {
    for (const id of state.lineup[s.key]) {
      const p = id && state.players[id];
      if (p) {
        counts[p.pos] = (counts[p.pos] || 0) + 1;
        total++;
      }
    }
  }
  for (const id of state.bench) {
    const p = id && state.players[id];
    if (p) {
      counts[p.pos] = (counts[p.pos] || 0) + 1;
      total++;
    }
  }
  const irUsed = state.ir.filter(Boolean).length;
  return { counts, total, irUsed };
}

export function canAddPlayer(state, pos) {
  const { counts, total } = rosterCounts(state);
  if (total >= MAX_ROSTER) return { ok: false, reason: `Roster is full (${MAX_ROSTER} spots)` };
  const limit = POS_LIMITS[pos];
  if (limit != null && (counts[pos] || 0) >= limit) {
    return { ok: false, reason: `League max reached at ${pos} (${limit})` };
  }
  return { ok: true };
}

let seq = 0;
export function newPlayerId() {
  seq += 1;
  return `p${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Add to first free bench slot. @returns {{state, error?, id?}} */
export function addPlayer(state, { name, team, pos, espnId, ecr, status }) {
  const clean = (name || "").trim();
  if (!clean) return { state, error: "Player name is required" };
  if (!POSITIONS.includes(pos)) return { state, error: "Pick a position" };
  const check = canAddPlayer(state, pos);
  if (!check.ok) return { state, error: check.reason };

  const id = newPlayerId();
  const next = cloneZones(state);
  next.players = {
    ...state.players,
    [id]: {
      id,
      name: clean,
      team: (team || "").trim().toUpperCase(),
      pos,
      espnId: (espnId || "").trim(),
      ecr: (ecr || "").trim(),
      status: STATUSES.includes(status) ? status : "",
      notes: "",
      weeks: {},
    },
  };
  // Bench first; otherwise an eligible empty starting slot.
  const spot = firstFree(next, "bench") || firstEmptyLegalSlot(next, id);
  if (!spot) return { state, error: `No open bench spot or eligible ${pos} slot` };
  writeZone(next, spot, id);
  return { state: next, id };
}

/** Remove from roster. @returns {{state, removed?, location?}} */
export function dropPlayer(state, id) {
  const loc = findLocation(state, id);
  const player = state.players[id];
  if (!loc || !player) return { state, error: "Player is not on the roster" };
  const next = cloneZones(state);
  writeZone(next, loc, null);
  next.players = { ...state.players };
  delete next.players[id];
  return { state: next, removed: player, location: loc };
}

/** Re-insert a previously dropped player, preferring their old location. */
export function restorePlayer(state, player, location) {
  const next = cloneZones(state);
  next.players = { ...state.players, [player.id]: player };
  if (location) {
    const occupied = readZone(next, location);
    if (!occupied) {
      writeZone(next, location, player.id);
      return { state: next };
    }
  }
  const free = firstFree(next, "bench");
  if (free) {
    writeZone(next, free, player.id);
    return { state: next };
  }
  // nowhere to put them — keep the player record out of the roster
  return { state, error: `No open spot to restore ${player.name}` };
}

/** Status change, auto-relocating when the new status makes the spot illegal. */
export function setStatus(state, id, status) {
  const p = state.players[id];
  if (!p) return { state, error: "Unknown player" };
  const next = cloneZones(state);
  next.players = { ...state.players, [id]: { ...p, status } };

  const loc = findLocation(next, id);
  if (!loc) return { state: next };

  // A player who is no longer IR cannot remain in an IR slot. Prefer the
  // bench, but fall back to any empty lineup slot they legally fit.
  if (loc.zone === "ir" && status !== "IR") {
    const spot = firstFree(next, "bench") || firstEmptyLegalSlot(next, id);
    if (!spot) return { state, error: "No open roster spot — free one before activating" };
    writeZone(next, loc, null);
    writeZone(next, spot, id);
    return { state: next };
  }

  // Flagging a starter IR is always allowed — the row is then marked as an
  // illegal start until it is moved to bench or IR. Auto-evicting here would
  // make the flag impossible whenever the bench is full.
  return { state: next };
}

/** Edit a player's own details (name/team/pos/espnId/ecr). Position changes
 *  are refused when the player's current slot wouldn't accept the new one. */
export function editPlayer(state, id, patch) {
  const p = state.players[id];
  if (!p) return { state, error: "Unknown player" };

  const next = { ...p };
  if (patch.name != null) {
    const clean = patch.name.trim();
    if (!clean) return { state, error: "Name can't be empty" };
    next.name = clean;
  }
  if (patch.team != null) next.team = patch.team.trim().toUpperCase();
  if (patch.espnId != null) next.espnId = patch.espnId.trim();
  if (patch.ecr != null) next.ecr = patch.ecr.trim();
  if (patch.pos != null && patch.pos !== p.pos) {
    if (!POSITIONS.includes(patch.pos)) return { state, error: "Unknown position" };
    const loc = findLocation(state, id);
    if (loc && loc.zone === "lineup" && !slotAccepts(loc.slotKey, patch.pos)) {
      return { state, error: `A ${patch.pos} can't sit in the ${loc.slotKey} slot — move them first` };
    }
    next.pos = patch.pos;
  }
  return { state: { ...state, players: { ...state.players, [id]: next } } };
}

// ------------------------------------------------------------ watch list ---

let watchSeq = 0;
export function addWatch(state, { name, team, note }) {
  const clean = (name || "").trim();
  if (!clean) return { state, error: "Name is required" };
  watchSeq += 1;
  const entry = {
    id: `w${Date.now().toString(36)}${watchSeq.toString(36)}`,
    name: clean,
    team: (team || "").trim().toUpperCase(),
    note: (note || "").trim(),
  };
  return { state: { ...state, watch: [...state.watch, entry] } };
}

export function removeWatch(state, id) {
  return { ...state, watch: state.watch.filter((w) => w.id !== id) };
}

export function updateWatch(state, id, patch) {
  return {
    ...state,
    watch: state.watch.map((w) => (w.id === id ? { ...w, ...patch } : w)),
  };
}

// -------------------------------------------------------------- game log ---

let callSeq = 0;
export function addCall(state, { player, week, type, reasoning }) {
  const clean = (player || "").trim();
  if (!clean) return { state, error: "Player is required" };
  callSeq += 1;
  const entry = {
    id: `g${Date.now().toString(36)}${callSeq.toString(36)}`,
    player: clean,
    week: week || state.week,
    type: type || "Start",
    reasoning: (reasoning || "").trim(),
  };
  return { state: { ...state, calls: [entry, ...state.calls] } };
}

export function removeCall(state, id) {
  return { ...state, calls: state.calls.filter((c) => c.id !== id) };
}

/**
 * Record how a call turned out. This is what turns the log from a diary into
 * calibration data — over a season it shows where your instincts are
 * systematically off, which no fantasy site can tell you because only you
 * know what you were thinking.
 */
export function setCallOutcome(state, id, outcome, resultNote) {
  return {
    ...state,
    calls: state.calls.map((c) =>
      c.id === id ? { ...c, outcome, result: resultNote != null ? resultNote : c.result } : c
    ),
  };
}

/** Where your calls actually land, split by how sure you were. */
export function callCalibration(calls) {
  const graded = (calls || []).filter((c) => c.outcome === "right" || c.outcome === "wrong");
  if (!graded.length) return null;
  const bucket = (c) => (c.confidence >= 4 ? "high" : c.confidence <= 2 ? "low" : "medium");
  const out = { total: graded.length, right: 0, byConfidence: {}, byType: {} };
  for (const c of graded) {
    const ok = c.outcome === "right";
    if (ok) out.right++;
    const b = bucket(c);
    out.byConfidence[b] = out.byConfidence[b] || { n: 0, right: 0 };
    out.byConfidence[b].n++;
    if (ok) out.byConfidence[b].right++;
    const t = c.type || "Start";
    out.byType[t] = out.byType[t] || { n: 0, right: 0 };
    out.byType[t].n++;
    if (ok) out.byType[t].right++;
  }
  out.rate = out.right / out.total;
  return out;
}

// -------------------------------------------------------------- interest ---
// One list covering every player you're tracking, whether they're a free
// agent, on someone else's roster, or already yours. Ownership is looked up
// live rather than baked in, so an entry never goes stale the way a hand-kept
// "waiver watch" does.

const interestKey = (name) => (name || "").toLowerCase().replace(/[^a-z]/g, "");

export function isInterested(state, name) {
  const k = interestKey(name);
  return (state.watch || []).some((w) => interestKey(w.name) === k);
}

let interestSeq = 0;
export function toggleInterest(state, { name, team, pos, note }) {
  const clean = (name || "").trim();
  if (!clean) return { state, error: "Name is required" };
  const k = interestKey(clean);
  const existing = (state.watch || []).find((w) => interestKey(w.name) === k);
  if (existing) {
    return { state: { ...state, watch: state.watch.filter((w) => w.id !== existing.id) }, removed: true };
  }
  interestSeq += 1;
  const entry = {
    id: `w${Date.now().toString(36)}${interestSeq.toString(36)}`,
    name: clean,
    team: (team || "").trim().toUpperCase(),
    pos: pos || "",
    note: (note || "").trim(),
  };
  return { state: { ...state, watch: [...(state.watch || []), entry] }, added: true };
}

// ------------------------------------------------------------------ byes ---

/**
 * The effective bye map every reader consumes: auto-derived values from the
 * schedule feed, with genuinely-manual entries layered on top.
 *
 * Keeping the two sources apart is the whole fix for the poisoned-bye bug —
 * when auto and manual shared one map, a bad auto value was indistinguishable
 * from a human correction and shadowed every later good fetch forever.
 */
export const resolveByes = (auto, manual) => normalizeByes({ ...(auto || {}), ...(manual || {}) });

/** Manual bye entry — a human typing it is the only thing that lands here. */
export function setBye(state, team, week) {
  const byesManual = { ...(state.byesManual || {}) };
  const w = parseInt(week, 10);
  if (!w || w < 1 || w > 18) delete byesManual[team];
  else byesManual[team] = w;
  return { ...state, byesManual, byes: resolveByes(state.byesAuto, byesManual) };
}

/** A pasted bye table is also a human entry — it outranks the feed. */
export function mergeByes(state, incoming) {
  const byesManual = normalizeByes({ ...(state.byesManual || {}), ...incoming });
  return { ...state, byesManual, byes: resolveByes(state.byesAuto, byesManual) };
}

/** Byes are numbers, enforced at every storage boundary — analysis.js once
 *  compared them as strings while scheduleSync compared numbers, and whether
 *  "on bye" worked depended on which module asked. */
export function normalizeByes(raw) {
  const byes = {};
  for (const [team, w] of Object.entries(raw || {})) {
    const n = parseInt(w, 10);
    if (n >= 1 && n <= 18) byes[team] = n;
  }
  return byes;
}

// ------------------------------------------------------------------ weeks ---

export function weekData(player, week) {
  return (player && player.weeks && player.weeks[week]) || { opp: "", matchup: 0 };
}

export function setWeekData(state, id, week, patch) {
  const p = state.players[id];
  if (!p) return state;
  const cur = weekData(p, week);
  return {
    ...state,
    players: {
      ...state.players,
      [id]: { ...p, weeks: { ...p.weeks, [week]: { ...cur, ...patch } } },
    },
  };
}

// ----------------------------------------------------------------- claims ---
// A Won claim owns three reversible effects: FAAB deduction, an added player,
// and a dropped player. Snapshots let un-marking restore all three.

export const clampFaab = (n) => Math.max(0, Math.min(100, n));

/** Apply the roster+FAAB effects of a claim becoming Won. */
export function applyWin(state, claim) {
  let next = state;
  const amt = parseInt(claim.amount, 10) || 0;
  const effects = { faabDelta: 0, addedId: null, dropped: null, droppedLoc: null };

  // drop first so the bench spot is available for the add
  if (claim.dropPlayerId && next.players[claim.dropPlayerId]) {
    const res = dropPlayer(next, claim.dropPlayerId);
    if (res.error) return { state, error: res.error };
    next = res.state;
    effects.dropped = res.removed;
    effects.droppedLoc = res.location;
  }

  if (claim.player && claim.player.trim()) {
    const res = addPlayer(next, {
      name: claim.player,
      team: claim.team || "",
      pos: claim.pos || "WR",
      espnId: claim.espnId || "",
    });
    if (res.error) return { state, error: res.error };
    next = res.state;
    effects.addedId = res.id;
  }

  effects.faabDelta = -amt;
  next = { ...next, faab: clampFaab(next.faab - amt) };
  return { state: next, effects };
}

/** Undo the effects recorded on a Won claim. */
export function revertWin(state, claim) {
  let next = state;
  const fx = claim.effects;
  if (!fx) return { state };

  if (fx.addedId && next.players[fx.addedId]) {
    const res = dropPlayer(next, fx.addedId);
    if (!res.error) next = res.state;
  }
  if (fx.dropped) {
    const res = restorePlayer(next, fx.dropped, fx.droppedLoc);
    if (res.error) return { state, error: res.error };
    next = res.state;
  }
  next = { ...next, faab: clampFaab(next.faab - (fx.faabDelta || 0)) };
  return { state: next };
}
