// ============================================================================
// ESPN → app state sync.
//
// /api/espn is the source of truth once cookies are configured: real rosters,
// real weekly projections, real injury tags, real matchup pairings. This
// module reconciles that against local state WITHOUT losing what only the app
// knows — scouting notes, per-week matchup grades, ECR strings, watchlist.
//
// Matching order for "is this ESPN player already in my app": espnId, then
// normalized name (with D/ST suffixes stripped) — D/ST units have no espnId
// in the seeds.
// ============================================================================

import { SLOT_DEFS, BENCH_SIZE, IR_SIZE, emptyZones, newPlayerId } from "./lineup.js";
import { LEAGUE_ROSTERS } from "./data/leagueRosters.js";

// ESPN proTeamId → abbreviation (stable ESPN internal ids)
export const PRO_TEAM = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

const INJURY = {
  QUESTIONABLE: "Q",
  DOUBTFUL: "D",
  OUT: "O",
  INJURY_RESERVE: "IR",
  SUSPENSION: "O",
};

export const normName = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/\bd\/?st\b/g, "")
    .replace(/[^a-z]/g, "");

/** Fuzzy-match an ESPN fantasy-team name to our transcribed LEAGUE_ROSTERS name. */
export function matchLeagueTeamName(espnName) {
  const k = normName(espnName);
  const hit = LEAGUE_ROSTERS.find((t) => normName(t.team) === k);
  return hit ? hit.team : espnName;
}

export async function fetchLeague(fresh = false) {
  // Vite's dev server has no /api routes — hit production directly there.
  const base = import.meta.env.DEV ? "https://the-huddle-hq.vercel.app" : "";
  // /api/espn sits behind a 30s edge cache. `fresh` busts it — required right
  // after a lineup write, when a cached pre-write snapshot would revert the
  // app's picture and re-trigger the drift guard.
  const buster = fresh ? `?fresh=${Date.now()}` : "";
  const r = await fetch(`${base}/api/espn${buster}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`ESPN endpoint returned ${r.status}`);
  return r.json();
}

export function findMyEspnTeam(data, myTeamName) {
  const k = normName(myTeamName);
  return (data.teams || []).find((t) => normName(t.name) === k) || null;
}

/**
 * Reconcile live ESPN state into app state. Pure — returns the next state and
 * a human-readable summary of what changed.
 */
export function applyEspnSync(state, data, myTeamName) {
  const me = findMyEspnTeam(data, myTeamName);
  if (!me) {
    return { state, error: `Couldn't find "${myTeamName}" among the ${data.teams?.length ?? 0} ESPN teams.` };
  }

  const week = String(data.currentWeek || state.week || "1");
  const summary = { added: [], dropped: [], projections: 0, statusChanges: [], week };

  // ---- index existing players ----
  const byEspnId = new Map();
  const byName = new Map();
  for (const p of Object.values(state.players)) {
    if (p.espnId) byEspnId.set(String(p.espnId), p);
    byName.set(normName(p.name), p);
  }

  // ---- build the new roster from ESPN's slots ----
  const { lineup, bench, ir } = emptyZones();
  const players = {};
  const cursor = {};
  const benchQueue = [];
  const irQueue = [];

  const espnStatus = (e) => INJURY[e.injuryStatus] || "";

  for (const entry of me.roster) {
    const existing = byEspnId.get(String(entry.espnId)) || byName.get(normName(entry.name)) || null;
    const id = existing ? existing.id : newPlayerId();
    if (!existing) summary.added.push(entry.name);

    const nextStatus = espnStatus(entry);
    if (existing && existing.status !== nextStatus) {
      summary.statusChanges.push(`${entry.name}: ${existing.status || "ACTIVE"} → ${nextStatus || "ACTIVE"}`);
    }

    players[id] = {
      id,
      name: existing ? existing.name : entry.name,
      team: PRO_TEAM[entry.proTeamId] || (existing ? existing.team : ""),
      pos: entry.pos || (existing ? existing.pos : "WR"),
      espnId: entry.espnId || (existing ? existing.espnId : ""),
      ecr: existing ? existing.ecr : "",
      status: nextStatus,
      // the app-only layers survive the sync untouched
      notes: existing ? existing.notes : "",
      weeks: existing ? existing.weeks : {},
    };

    // Mirror ESPN's actual lineup arrangement.
    const slot = entry.slot;
    if (slot === "BE") benchQueue.push(id);
    else if (slot === "IR") irQueue.push(id);
    else if (lineup[slot]) {
      cursor[slot] = cursor[slot] || 0;
      if (cursor[slot] < lineup[slot].length) lineup[slot][cursor[slot]++] = id;
      else benchQueue.push(id); // ESPN allows configs we don't model; bench overflow
    } else {
      benchQueue.push(id);
    }
  }

  benchQueue.slice(0, BENCH_SIZE).forEach((id, i) => (bench[i] = id));
  benchQueue.slice(BENCH_SIZE).forEach((id) => {
    const free = ir.indexOf(null);
    if (free >= 0) ir[free] = id; // overflow safety net; shouldn't happen at 16+2
  });
  irQueue.slice(0, IR_SIZE).forEach((id) => {
    const free = ir.indexOf(null);
    if (free >= 0) ir[free] = id;
  });

  // dropped = anyone previously rostered who didn't come back from ESPN
  for (const p of Object.values(state.players)) {
    if (!players[p.id]) summary.dropped.push(p.name);
  }

  // ---- ESPN projections into the analytics layer, for everyone rostered ----
  let analytics = { ...(state.analytics || {}) };
  const writeProj = (playerId, proj) => {
    if (!Number.isFinite(proj) || proj <= 0) return;
    const forPlayer = { ...(analytics[playerId] || {}) };
    forPlayer[week] = { ...(forPlayer[week] || {}), proj, projSource: "espn" };
    analytics[playerId] = forPlayer;
    summary.projections++;
  };
  for (const entry of me.roster) {
    const p = Object.values(players).find(
      (x) => (entry.espnId && String(x.espnId) === String(entry.espnId)) || normName(x.name) === normName(entry.name)
    );
    if (p) writeProj(p.id, entry.proj);
  }

  // ---- opponent for this week, from the real pairings ----
  let matchups = state.matchups || {};
  const pairing = (data.matchups || []).find((m) => m.home === me.id || m.away === me.id);
  if (pairing) {
    const oppId = pairing.home === me.id ? pairing.away : pairing.home;
    const oppTeam = (data.teams || []).find((t) => t.id === oppId);
    if (oppTeam) {
      const mapped = matchLeagueTeamName(oppTeam.name);
      matchups = { ...matchups, [week]: { ...(matchups[week] || {}), oppTeam: mapped } };
      summary.opponent = mapped;
    }
  }

  // ---- keep the full league snapshot for opponent projections + ownership ----
  const espn = {
    fetchedAt: data.fetchedAt || Date.now(),
    currentWeek: data.currentWeek,
    leagueName: data.leagueName,
    myTeamId: me.id,
    // League's real per-stat scoring from mSettings — projections and props
    // conversion read this instead of guessing (6-pt pass TDs, rush attempts).
    scoring: data.scoring || null,
    leagueFaab: Number.isFinite(data.leagueFaab) ? data.leagueFaab : 100,
    teams: (data.teams || []).map((t) => ({
      id: t.id,
      name: t.name,
      mapped: matchLeagueTeamName(t.name),
      record: t.record,
      faabSpent: Number.isFinite(t.faabSpent) ? t.faabSpent : null,
      roster: t.roster.map((e) => ({
        name: e.name,
        pos: e.pos,
        team: PRO_TEAM[e.proTeamId] || "",
        slot: e.slot,
        proj: e.proj,
        actual: e.actual,
        espnId: e.espnId,
        injuryStatus: e.injuryStatus,
        percentOwned: e.percentOwned,
      })),
    })),
    matchups: data.matchups || [],
    games: data.games || {}, // NFL game states: abbr -> {state, pctRemaining, detail}
    impliedTotals: data.impliedTotals || {}, // abbr -> Vegas implied team total
    pool: (data.pool || []).map((p) => ({ ...p, team: PRO_TEAM[p.proTeamId] || "" })),
    // Position ranks derived from ESPN's own projections across the whole
    // pool — rankings without anyone pasting anything. Pasted expert ranks
    // still win where they exist.
    autoRanks: buildAutoRanks(data.pool || []),
  };

  // ---- real FAAB from ESPN's transaction counter ----
  let faab = state.faab;
  if (me.faabSpent != null) {
    faab = Math.max(0, (data.leagueFaab ?? 100) - me.faabSpent);
    if (faab !== state.faab) summary.faab = faab;
  }

  // ---- claims resolve themselves against reality ----
  // A pending claim's player either landed on your roster (won — roster and
  // FAAB are already true via the sync, so no side effects to apply), landed
  // on someone else's (lost, and we can say who beat you), or is still free.
  const ownerOfName = (name) => {
    const k = normName(name);
    for (const t of espn.teams) {
      if (t.roster.some((e) => normName(e.name) === k)) return t;
    }
    return null;
  };
  const claims = (state.claims || []).map((c) => {
    if (c.result !== "Pending" || !c.player) return c;
    const mineNow = Object.values(players).some((p) => normName(p.name) === normName(c.player));
    if (mineNow) {
      summary.claimsResolved = (summary.claimsResolved || 0) + 1;
      return { ...c, result: "Won", effects: null, autoResolved: true };
    }
    const owner = ownerOfName(c.player);
    if (owner && owner.id !== me.id) {
      summary.claimsResolved = (summary.claimsResolved || 0) + 1;
      return { ...c, result: "Lost", autoResolved: true, lostTo: owner.mapped || owner.name };
    }
    return c;
  });

  return {
    state: { ...state, week, players, lineup, bench, ir, analytics, matchups, espn, faab, claims },
    summary,
  };
}

/** Live roster for a league team (by our mapped name), if a sync has happened. */
export function espnTeamRoster(state, mappedName) {
  if (!state.espn) return null;
  const k = normName(mappedName);
  const t = state.espn.teams.find((x) => normName(x.mapped) === k || normName(x.name) === k);
  return t ? t.roster : null;
}

/** Who rosters this player according to the latest sync (null = free agent). */
export function liveOwner(state, playerName) {
  if (!state.espn) return null;
  const k = normName(playerName);
  for (const t of state.espn.teams) {
    if (t.id === state.espn.myTeamId) continue;
    if (t.roster.some((e) => normName(e.name) === k)) return t.mapped;
  }
  return null;
}

/** True when a sync exists and this player is on nobody's roster. */
export function isLiveFreeAgent(state, playerName) {
  if (!state.espn) return null; // unknown — no sync yet
  const k = normName(playerName);
  return !state.espn.teams.some((t) => t.roster.some((e) => normName(e.name) === k));
}

/** normalizedName -> position rank, from projection order within each position. */
function buildAutoRanks(pool) {
  const byPos = {};
  for (const p of pool) {
    if (!p.name || !p.pos || !(p.proj > 0)) continue;
    // ESPN's model projects UNSIGNED veterans off historical stats (Tyreek
    // Hill "WR7" with no team). A player who can't take a snap gets no rank —
    // otherwise he squats on a slot and pushes every real player down one.
    if (!p.proTeamId) continue;
    (byPos[p.pos] = byPos[p.pos] || []).push(p);
  }
  const out = {};
  for (const players of Object.values(byPos)) {
    players.sort((a, b) => b.proj - a.proj);
    players.forEach((p, i) => {
      out[normName(p.name)] = i + 1;
    });
  }
  return out;
}

/** Any NFL game currently being played? Drives the live polling cadence. */
export function anyGameLive(state) {
  const games = state.espn && state.espn.games;
  if (!games) return false;
  return Object.values(games).some((g) => g.state === "in");
}

/**
 * Auto live entry for a player from the ESPN snapshot: what they've scored
 * plus their NFL game's state. Manual edits in the Gameday editor override
 * this — the human at the stadium beats a two-minute-old poll.
 */
export function liveEntryFor(state, playerName, teamAbbr) {
  if (!state.espn) return null;
  const k = normName(playerName);
  let entry = null;
  for (const t of state.espn.teams) {
    const hit = t.roster.find((e) => normName(e.name) === k);
    if (hit) {
      entry = hit;
      break;
    }
  }
  const game = state.espn.games ? state.espn.games[teamAbbr] : null;
  if (!entry && !game) return null;

  const gs = game ? game.state : null;
  return {
    scored: entry && Number.isFinite(entry.actual) ? entry.actual : 0,
    status: gs === "post" ? "final" : gs === "in" ? "inProgress" : "notStarted",
    pctRemaining: game ? game.pctRemaining : 1,
    detail: game ? game.detail : "",
  };
}

export function summaryToText(s) {
  const bits = [];
  if (s.added.length) bits.push(`+${s.added.length} added (${s.added.join(", ")})`);
  if (s.dropped.length) bits.push(`−${s.dropped.length} dropped (${s.dropped.join(", ")})`);
  if (s.statusChanges.length) bits.push(`${s.statusChanges.length} status change${s.statusChanges.length === 1 ? "" : "s"}`);
  bits.push(`${s.projections} projections`);
  if (s.opponent) bits.push(`opponent: ${s.opponent}`);
  if (s.faab != null) bits.push(`FAAB $${s.faab}`);
  if (s.claimsResolved) bits.push(`${s.claimsResolved} claim${s.claimsResolved === 1 ? "" : "s"} auto-resolved`);
  return `ESPN sync · week ${s.week} · ${bits.join(" · ")}`;
}
