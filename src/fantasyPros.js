// ============================================================================
// FantasyPros feed: canonical player ids and the news wire.
//
// Two jobs, deliberately in one module because the second depends on the
// first:
//
//   1. Canonical ids (handoff Step 5). The roster matcher has needed hand-
//      fixing, rosterSearch is defined three times, and name normalization
//      lives in six places. A stable `fpId` on each player ends that class of
//      bug for anything sourced from FantasyPros.
//
//      Scope note, because the handoff doc overstates this: /players carries
//      `sportsdata_player_id` (Sportradar) and nothing else external. There is
//      NO ESPN id in the response, so this does not fix ESPN <-> Odds API
//      matching. It fixes FantasyPros matching, which is what Step 4 needs.
//
//   2. News for one player (handoff Step 4). The server already joins each
//      item to a player, so matching here is an id comparison with a name-key
//      fallback for the handful the index misses.
//
// Both feeds are server-cached; these fetchers are called once per session.
// ============================================================================

const base = () => (import.meta.env && import.meta.env.DEV ? "https://the-huddle-hq.vercel.app" : "");

export const fpKey = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

async function get(resource, timeoutMs) {
  const r = await fetch(`${base()}/api/fantasypros?resource=${resource}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`/api/fantasypros?resource=${resource} returned ${r.status}`);
  const d = await r.json();
  if (!d.configured) throw new Error(d.reason || "FantasyPros not configured");
  return d;
}

export const fetchFpPlayers = () => get("players", 15000);
export const fetchFpNews = () => get("news", 10000);

/**
 * A roster player -> FantasyPros id, or null.
 *
 * D/ST is the one case names cannot carry: FantasyPros says "Pittsburgh
 * Steelers", this app says "Steelers". They agree on the team abbreviation,
 * so defences match on that instead of on a city-prefix rule that would only
 * ever be used here.
 */
export function fpIdFor(index, player) {
  if (!index || !player) return null;
  if (player.fpId && index.byId && index.byId[player.fpId]) return player.fpId;
  if (player.pos === "DST" || player.pos === "D/ST") {
    const byTeam = (index.byTeamDst || {})[player.team];
    if (byTeam) return byTeam;
  }
  return (index.byName || {})[fpKey(player.name)] || null;
}

/**
 * Which players gained an id this pass. Returned as a plain map so the caller
 * does one setState rather than one per player.
 */
export function resolveFpIds(players, index) {
  const out = {};
  for (const p of Object.values(players || {})) {
    if (p.fpId) continue;
    const id = fpIdFor(index, p);
    if (id) out[p.id] = id;
  }
  return out;
}

/** FantasyPros sends "2026-09-11 18:46:38" in UTC, which Safari will not parse. */
export function fpDate(created) {
  if (!created) return null;
  const iso = String(created).trim().replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "Sep 11" — the date this was true, which every piece of intel must carry. */
export function fpDateLabel(created) {
  const d = fpDate(created);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * This player's news, newest first.
 *
 * Matching is by canonical id when both sides have one, and by name key
 * otherwise. That fallback is an exact normalized-name compare, NOT a fuzzy
 * matcher — the app already has six name-normalization sites and adding a
 * seventh with its own similarity rules would make the known problem worse.
 */
export function newsForPlayer(items, player, index, limit = 4) {
  if (!Array.isArray(items) || !player) return [];
  const id = fpIdFor(index, player);
  const nameKey = fpKey(player.name);
  const hits = items.filter((it) => (id && it.fpid === id) || (it.name && fpKey(it.name) === nameKey));
  hits.sort((a, b) => {
    const da = fpDate(a.created);
    const db = fpDate(b.created);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });
  return hits.slice(0, limit);
}
