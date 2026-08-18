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
import { LEAGUE_ROSTERS, MY_TEAM } from "./data/leagueRosters.js";
import { authHeaders, NO_TOKEN_ERROR } from "./authToken.js";

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
  // /api/espn sits behind a 30s private cache. `fresh` busts it — required
  // right after a lineup write, when a cached pre-write snapshot would revert
  // the app's picture and re-trigger the drift guard.
  const buster = fresh ? `?fresh=${Date.now()}` : "";
  const headers = authHeaders();
  if (!headers) throw new Error(NO_TOKEN_ERROR);
  const r = await fetch(`${base}/api/espn${buster}`, { cache: "no-store", headers });
  if (r.status === 401) {
    throw new Error("Huddle token rejected — check the token in Import & share.");
  }
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
  const summary = { added: [], dropped: [], projections: 0, statusChanges: [], overflow: [], week };

  // Zone sizes come from the league's own settings when ESPN reports them
  // (slot 20 = bench, 21 = IR); the constants are only a fallback.
  const slotCounts = data.rosterSlots || {};
  const benchSize = Number.isFinite(slotCounts["20"]) && slotCounts["20"] > 0 ? slotCounts["20"] : BENCH_SIZE;
  const irSize = Number.isFinite(slotCounts["21"]) && slotCounts["21"] >= 0 ? slotCounts["21"] : IR_SIZE;

  // ---- index existing players ----
  const byEspnId = new Map();
  const byName = new Map(); // norm name -> ARRAY: real duplicate names exist
  for (const p of Object.values(state.players)) {
    if (p.espnId) byEspnId.set(String(p.espnId), p);
    const k = normName(p.name);
    byName.set(k, [...(byName.get(k) || []), p]);
  }

  /**
   * Which existing record (if any) this ESPN entry refers to.
   *
   * Two entries could previously resolve to the SAME existing player — the
   * second overwrote the first in `players` and both pushed that id into the
   * zones, so one player silently vanished. Real duplicate names exist
   * (Michael Thomas, Josh Allen, Justin Jackson) and D/ST units carry no
   * espnId at all, so the name path has to refuse when it's ambiguous.
   */
  const claimed = new Set();
  const resolveExisting = (entry) => {
    const byId = entry.espnId ? byEspnId.get(String(entry.espnId)) : null;
    if (byId && !claimed.has(byId.id)) return byId;
    const sameName = byName.get(normName(entry.name)) || [];
    // exactly one candidate, and nobody has taken it yet
    if (sameName.length === 1 && !claimed.has(sameName[0].id)) return sameName[0];
    return null; // ambiguous or already spoken for → treat as a new player
  };

  // ---- build the new roster from ESPN's slots ----
  const { lineup, bench, ir } = emptyZones(benchSize, irSize);
  const players = {};
  const cursor = {};
  const benchQueue = [];
  const irQueue = [];

  const espnStatus = (e) => INJURY[e.injuryStatus] || "";

  for (const entry of me.roster) {
    const existing = resolveExisting(entry);
    const id = existing ? existing.id : newPlayerId();
    if (existing) claimed.add(existing.id);
    else summary.added.push(entry.name);

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

  // IR FIRST. Bench overflow used to claim IR slots before genuinely-IR'd
  // players got one, which pushed a real player into no zone at all — and an
  // unplaced player was then deleted by migrate on the next page load, taking
  // their notes, ECR and week history with them.
  const place = (id) => {
    const free = ir.indexOf(null);
    if (free >= 0) {
      ir[free] = id;
      return true;
    }
    return false;
  };
  for (const id of irQueue) {
    if (!place(id)) summary.overflow.push(players[id]?.name || id);
  }
  benchQueue.slice(0, bench.length).forEach((id, i) => (bench[i] = id));
  for (const id of benchQueue.slice(bench.length)) {
    // Anyone we cannot seat is REPORTED, never silently dropped.
    if (!place(id)) summary.overflow.push(players[id]?.name || id);
  }

  // dropped = anyone previously rostered who didn't come back from ESPN
  for (const p of Object.values(state.players)) {
    if (!players[p.id]) summary.dropped.push(p.name);
  }

  // ---- ESPN projections into the analytics layer, for everyone rostered ----
  let analytics = { ...(state.analytics || {}) };
  const writeProj = (playerId, proj) => {
    // ZERO IS DATA. ESPN projects 0.0 for a player on bye or ruled out;
    // discarding it (the old `proj <= 0` guard) left the optimizer reading a
    // stale pasted projection and cheerfully recommending you start him.
    // "ESPN says zero" and "we have no number" must stay distinguishable.
    if (!Number.isFinite(proj)) return;
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

/**
 * Global player lookup — THE shared search engine. Case-insensitive partial
 * match across every player the league knows about: all 10 rosters (with
 * owner) plus the full ESPN pool (free agents). One source of truth for the
 * home search panel, the watchlist add box, and the claim form.
 *
 * @returns Array<{name, pos, team, owner: string|null, mine: boolean,
 *                 proj: number|null, percentOwned: number|null}>
 *          owner null = free agent; mine = on YOUR roster.
 */
export function searchLeaguePlayers(state, query, limit = 10) {
  const q = normName(query);
  if (!q || q.length < 2) return [];

  const found = new Map(); // normName -> record (rosters first: they know the owner)
  if (state.espn && state.espn.teams && state.espn.teams.length) {
    for (const t of state.espn.teams) {
      const mine = t.id === state.espn.myTeamId;
      for (const e of t.roster || []) {
        const k = normName(e.name);
        if (!k.includes(q) || found.has(k)) continue;
        found.set(k, {
          name: e.name,
          pos: e.pos,
          team: e.team || "",
          owner: mine ? null : t.mapped || t.name,
          mine,
          proj: Number.isFinite(e.proj) ? e.proj : null,
          percentOwned: e.percentOwned ?? null,
        });
      }
    }
    for (const p of state.espn.pool || []) {
      const k = normName(p.name);
      if (!k.includes(q) || found.has(k)) continue;
      // onTeamId > 0 without a roster hit shouldn't happen, but stay honest.
      const owningTeam = p.onTeamId ? (state.espn.teams || []).find((t) => t.id === p.onTeamId) : null;
      found.set(k, {
        name: p.name,
        pos: p.pos,
        team: p.team || "",
        owner: owningTeam ? owningTeam.mapped || owningTeam.name : null,
        mine: !!owningTeam && owningTeam.id === state.espn.myTeamId,
        proj: Number.isFinite(p.proj) ? p.proj : null,
        percentOwned: p.percentOwned ?? null,
      });
    }
  } else {
    // Offline fallback: the hand-transcribed snapshot (ages with every trade).
    for (const t of LEAGUE_ROSTERS) {
      for (const g of [t.starters, t.bench, t.ir]) {
        for (const [name, team, pos] of g || []) {
          const k = normName(name);
          if (!k.includes(q) || found.has(k)) continue;
          found.set(k, {
            name,
            pos,
            team: team || "",
            owner: t.team === MY_TEAM ? null : t.team,
            mine: t.team === MY_TEAM,
            proj: null,
            percentOwned: null,
          });
        }
      }
    }
  }

  const res = [...found.values()];
  res.sort((a, b) => {
    const as = normName(a.name).startsWith(q) ? 0 : 1;
    const bs = normName(b.name).startsWith(q) ? 0 : 1;
    if (as !== bs) return as - bs;
    return (b.percentOwned ?? 0) - (a.percentOwned ?? 0);
  });
  return res.slice(0, limit);
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
  if (s.overflow && s.overflow.length) bits.push(`⚠ no roster spot for ${s.overflow.join(", ")}`);
  bits.push(`${s.projections} projections`);
  if (s.opponent) bits.push(`opponent: ${s.opponent}`);
  if (s.faab != null) bits.push(`FAAB $${s.faab}`);
  if (s.claimsResolved) bits.push(`${s.claimsResolved} claim${s.claimsResolved === 1 ? "" : "s"} auto-resolved`);
  return `ESPN sync · week ${s.week} · ${bits.join(" · ")}`;
}
