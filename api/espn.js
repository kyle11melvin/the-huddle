// ============================================================================
// ESPN fantasy proxy.
//
// Reads league state straight from ESPN so drops/adds on their site show up
// here. Private leagues need two auth cookies; those live ONLY in Vercel
// environment variables that the account owner sets themselves:
//
//   ESPN_LEAGUE_ID   e.g. 69676714
//   ESPN_SEASON      e.g. 2026
//   ESPN_SWID        {XXXXXXXX-....}   (cookie)
//   ESPN_S2          AEB....           (cookie, very long)
//
// Until they exist this returns {configured:false} and the app falls back to
// manual entry — nothing breaks, it just isn't automatic yet.
//
// ESPN's fantasy API is undocumented and can change without notice, which is
// why the manual paths stay in place rather than being replaced.
// ============================================================================

import { applyCors, isAuthorized, sendUnauthorized, rejectUnknownParams, TIMEOUT_MS, isAbort } from "./_auth.js";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

// mRoster: who is on each team · mTeam: team names/owners · mMatchup: schedule
// and scores · mSettings: scoring rules · kona_player_info: the player pool
const VIEWS = ["mRoster", "mTeam", "mMatchup", "mSettings"];

const SLOT = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K",
  23: "FLEX", 20: "BE", 21: "IR",
};
const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

function send(res, status, body, cacheSeconds) {
  res.setHeader("Content-Type", "application/json");
  // PRIVATE cache only. This response is now token-gated, and a shared/CDN
  // cache keyed on URL alone would happily replay an authorized 200 to an
  // unauthenticated caller — the edge serves it without ever invoking this
  // function, silently undoing the auth check. `private` keeps the browser
  // cache (which still covers the 2-min Gameday poll and multiple tabs in
  // the same browser) while forbidding any shared cache from storing it.
  res.setHeader(
    "Cache-Control",
    cacheSeconds ? `private, max-age=${cacheSeconds}` : "no-store"
  );
  res.status(status).send(JSON.stringify(body));
}

// ESPN scoringItems statId → our scoring key. Only the stats the projection
// and props engines actually price; kicking/defense stay on ESPN's own math.
const STAT_KEY = {
  3: "passYd", 4: "passTd", 19: "passTwoPt", 20: "int",
  23: "rushAtt", 24: "rushYd", 25: "rushTd", 26: "rushTwoPt",
  42: "recYd", 43: "recTd", 44: "recTwoPt", 53: "reception",
  72: "fumble",
};

/**
 * ESPN's weekly projection AND where it came from.
 *
 * The BASIS matters. "ESPN's week-1 projection" and "ESPN's season projection
 * ÷ 17" are different claims, and both used to be returned as a bare number.
 * As ESPN posts real weekly projections through the preseason a player can
 * swing 40%+ purely because the source switched — which reads as news and
 * isn't. The calibration ledger would otherwise bank that artifact as a
 * projection error and quietly poison the accuracy comparison.
 *
 * @returns {{value: number|null, basis: 'weekly'|'weekly-other'|'season/17'|null}}
 */
export function weeklyProj(p, currentPeriod) {
  const stats = (p && p.stats) || [];
  const exact = stats.find(
    (s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === currentPeriod
  );
  if (exact) return { value: Math.round((exact.appliedTotal || 0) * 10) / 10, basis: "weekly" };
  const anyWeek = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 1);
  if (anyWeek) return { value: Math.round((anyWeek.appliedTotal || 0) * 10) / 10, basis: "weekly-other" };
  // only a season projection exists → per-game baseline, same scale
  const season = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0);
  if (season && season.appliedTotal > 0) {
    return { value: Math.round((season.appliedTotal / 17) * 10) / 10, basis: "season/17" };
  }
  return { value: null, basis: null };
}

/**
 * Which matchup period the returned pairings belong to. ESPN omits `status`
 * often enough that this can't be read blind — comparing against `undefined`
 * matches nothing and empties the whole matchups array.
 */
export function currentMatchupPeriod(data) {
  const explicit = data && data.status && data.status.currentMatchupPeriod;
  if (Number.isFinite(explicit)) return explicit;
  // Without this fallback a missing `status` made the filter compare against
  // undefined, matching nothing — so `matchups` came back empty and the
  // opponent was silently unset, with no error anywhere.
  return data && data.scoringPeriodId;
}

/** League's real per-stat points from mSettings — the app should never guess. */
export function extractScoring(settings) {
  const items = (settings && settings.scoringSettings && settings.scoringSettings.scoringItems) || [];
  const out = {};
  for (const it of items) {
    const k = STAT_KEY[it.statId];
    if (!k) continue;
    // Some leagues store the live value in pointsOverrides["16"] (PPR slot).
    // Key on the property's PRESENCE, not its value: `override !== 0` could
    // not tell "no override" from "override is deliberately 0", so a league
    // that zeroed out PPR would still be scored as if receptions counted.
    const ov = it.pointsOverrides;
    const hasOverride = ov && Object.prototype.hasOwnProperty.call(ov, "16");
    const pts = hasOverride ? Number(ov["16"]) : it.points;
    if (Number.isFinite(pts)) out[k] = pts;
  }
  return out;
}

export default async function handler(req, res) {
  applyCors(req, res, "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  // First thing after CORS: an unauthorized caller must cost us nothing —
  // no ESPN fetch, no cookie read, no ESPN rate-limit budget.
  if (!isAuthorized(req)) return sendUnauthorized(res);
  // `fresh` busts the client cache after a write; `week` scopes the read;
  // `debugScoring` dumps raw mSettings for auditing the scoring extraction.
  if (!rejectUnknownParams(req, res, ["fresh", "week", "debugScoring"])) return;

  const leagueId = process.env.ESPN_LEAGUE_ID;
  const season = process.env.ESPN_SEASON || "2026";
  const swid = process.env.ESPN_SWID;
  const s2 = process.env.ESPN_S2;

  if (!leagueId) {
    return send(res, 200, {
      configured: false,
      reason: "ESPN_LEAGUE_ID is not set.",
      needs: ["ESPN_LEAGUE_ID", "ESPN_SEASON", "ESPN_SWID", "ESPN_S2"],
    });
  }

  // `?week=1&week=2` arrives as an array and would stringify to "1,2".
  const rawWeek = Array.isArray(req.query.week) ? req.query.week[0] : req.query.week;
  const weekNum = parseInt(rawWeek, 10);
  const week = Number.isFinite(weekNum) && weekNum >= 1 && weekNum <= 18
    ? `&scoringPeriodId=${weekNum}`
    : "";
  const url = `${BASE}/${season}/segments/0/leagues/${leagueId}?${VIEWS.map((v) => `view=${v}`).join("&")}${week}`;

  const headers = { Accept: "application/json" };
  if (swid && s2) headers.Cookie = `SWID=${swid}; espn_s2=${s2}`;

  // Weekly projection extractor. ESPN mixes season totals and single-week
  // projections in the same stats array; grabbing the wrong one made Tyreek
  // Hill "project" 273 points in a week. statSplitTypeId 1 = one week.

  // Full player pool for THIS league — includes free agents, their weekly
  // projections and ownership. This is what lets rankings and the FA list
  // exist without anyone pasting anything.
  const poolPromise = fetch(
    `${BASE}/${season}/segments/0/leagues/${leagueId}?view=kona_player_info`,
    {
      headers: {
        ...headers,
        "x-fantasy-filter": JSON.stringify({
          players: { limit: 350, sortPercOwned: { sortPriority: 1, sortAsc: false } },
        }),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  )
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null); // pool is an enhancement — a slow pool must not fail the sync

  try {
    const r = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 401) {
      return send(res, 200, {
        configured: false,
        reason: swid && s2
          ? "ESPN rejected the stored cookies — they expire, so they may need refreshing."
          : "This league is private; ESPN_SWID and ESPN_S2 must be set.",
      });
    }
    if (!r.ok) return send(res, 502, { configured: true, error: `ESPN returned ${r.status}` });

    const data = await r.json();

    const teams = (data.teams || []).map((t) => ({
      id: t.id,
      name: [t.location, t.nickname].filter(Boolean).join(" ").trim() || t.name || `Team ${t.id}`,
      abbrev: t.abbrev,
      logo: t.logo,
      record: t.record && t.record.overall
        ? { w: t.record.overall.wins, l: t.record.overall.losses, t: t.record.overall.ties }
        : null,
      faabSpent:
        t.transactionCounter && Number.isFinite(t.transactionCounter.acquisitionBudgetSpent)
          ? t.transactionCounter.acquisitionBudgetSpent
          : null,
      roster: ((t.roster && t.roster.entries) || []).map((e) => {
        const p = (e.playerPoolEntry && e.playerPoolEntry.player) || {};
        const realStat = (p.stats || []).find(
          (s) => s.statSourceId === 0 && s.scoringPeriodId === data.scoringPeriodId
        );
        return {
          espnId: String(p.id ?? ""),
          name: p.fullName || "",
          pos: POS[p.defaultPositionId] || "",
          proTeamId: p.proTeamId,
          slot: SLOT[e.lineupSlotId] ?? String(e.lineupSlotId),
          injured: !!p.injured,
          injuryStatus: p.injuryStatus || "",
          percentOwned: p.ownership ? Math.round((p.ownership.percentOwned || 0) * 10) / 10 : null,
          proj: weeklyProj(p, data.scoringPeriodId).value,
          projBasis: weeklyProj(p, data.scoringPeriodId).basis,
          actual: realStat ? Math.round((realStat.appliedTotal || 0) * 10) / 10 : null,
        };
      }),
    }));

    // This week's head-to-head pairings, so the simulator knows who you face.
    const currentWeek = data.scoringPeriodId;
    const matchups = (data.schedule || [])
      .filter((m) => m.matchupPeriodId === currentMatchupPeriod(data))
      .map((m) => ({
        home: m.home && m.home.teamId,
        away: m.away && m.away.teamId,
        homeScore: m.home && m.home.totalPoints,
        awayScore: m.away && m.away.totalPoints,
      }));

    // abbr -> { state: 'pre'|'in'|'post', pctRemaining, detail }
    const games = {};
    // abbr -> Vegas implied team total (points the market expects them to score)
    const impliedTotals = {};
    const fixT = (a) => (a === "WAS" ? "WSH" : a === "JAC" ? "JAX" : a);
    // Explicit season/week: the bare scoreboard URL returns whatever ESPN's
    // "today" is (empty between preseason slates); the league's current
    // scoring period is the week whose games and odds we actually want.
    const sb = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${data.scoringPeriodId || 1}&dates=${season}`,
      { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
      .then((x) => (x.ok ? x.json() : null))
      .catch(() => null);
    for (const ev of (sb && sb.events) || []) {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) continue;
      const st = comp.status || ev.status || {};
      const stateRaw = (st.type && st.type.state) || "pre";
      let pctRemaining = stateRaw === "post" ? 0 : 1;
      if (stateRaw === "in") {
        const period = st.period || 1;
        const clock = typeof st.clock === "number" ? st.clock : 900; // seconds left in period
        const regRemaining = Math.max(0, (4 - period) * 900 + clock);
        pctRemaining = Math.max(0.02, Math.min(1, regRemaining / 3600));
      }
      const homeC = (comp.competitors || []).find((c) => c.homeAway === "home");
      const awayC = (comp.competitors || []).find((c) => c.homeAway === "away");
      const homeAbbr = homeC && homeC.team && fixT(homeC.team.abbreviation);
      const awayAbbr = awayC && awayC.team && fixT(awayC.team.abbreviation);
      for (const abbr of [homeAbbr, awayAbbr]) {
        if (abbr) {
          games[abbr] = {
            state: stateRaw,
            pctRemaining: Math.round(pctRemaining * 100) / 100,
            detail: (st.type && st.type.shortDetail) || "",
            // Absolute kickoff, so the client can run a real countdown instead
            // of reprinting ESPN's display string.
            startTime: ev.date || (comp && comp.date) || null,
          };
        }
      }
      // spread is quoted for the home side: home -3.5 in a 49.5 total means
      // home implied 26.5, away 23.
      const odds = comp.odds && comp.odds[0];
      if (odds && Number.isFinite(odds.overUnder) && Number.isFinite(odds.spread) && homeAbbr && awayAbbr) {
        const home = odds.overUnder / 2 - odds.spread / 2;
        impliedTotals[homeAbbr] = Math.round(home * 10) / 10;
        impliedTotals[awayAbbr] = Math.round((odds.overUnder - home) * 10) / 10;
      }
    }

    // league player pool → slim records; onTeamId 0 = free agent
    const poolData = await poolPromise;
    const pool = ((poolData && poolData.players) || [])
      .map((e) => {
        const p = e.player || {};
        return {
          espnId: String(p.id ?? ""),
          name: p.fullName || "",
          pos: POS[p.defaultPositionId] || "",
          proTeamId: p.proTeamId,
          onTeamId: e.onTeamId || 0,
          percentOwned: p.ownership ? Math.round((p.ownership.percentOwned || 0) * 10) / 10 : null,
          proj: weeklyProj(p, data.scoringPeriodId).value,
          projBasis: weeklyProj(p, data.scoringPeriodId).basis,
        };
      })
      .filter((x) => x.name && x.pos);

    return send(res, 200, {
      configured: true,
      leagueId,
      season,
      currentWeek,
      games,
      impliedTotals,
      pool,
      leagueName: data.settings && data.settings.name,
      leagueFaab:
        data.settings && data.settings.acquisitionSettings && Number.isFinite(data.settings.acquisitionSettings.acquisitionBudget)
          ? data.settings.acquisitionSettings.acquisitionBudget
          : 100,
      scoring: extractScoring(data.settings),
      // Roster shape is a league setting, not a constant: slot 20 = bench,
      // 21 = IR. Leagues running 7 bench spots used to silently lose the
      // 7th player on the next page load.
      rosterSlots:
        (data.settings && data.settings.rosterSettings && data.settings.rosterSettings.lineupSlotCounts) || null,
      // raw scoringItems on demand, for auditing the extraction
      ...(req.query.debugScoring
        ? {
            scoringRaw: ((data.settings || {}).scoringSettings || {}).scoringItems,
            // per-stat applied points for a QB and an RB projection — the
            // empirical ground truth for yardage/attempt rates
            statSamples: ((poolData && poolData.players) || [])
              .filter((e) => {
                const pid = e.player && e.player.defaultPositionId;
                return pid === 1 || pid === 2;
              })
              .slice(0, 6)
              .map((e) => {
                const p = e.player || {};
                const wk = (p.stats || []).find((s) => s.statSourceId === 1 && s.statSplitTypeId === 1);
                return wk
                  ? { name: p.fullName, pos: POS[p.defaultPositionId], total: wk.appliedTotal, stats: wk.stats, applied: wk.appliedStats }
                  : null;
              })
              .filter(Boolean),
          }
        : {}),
      scoringType: data.settings && data.settings.scoringSettings ? data.settings.scoringSettings.scoringType : null,
      teams,
      matchups,
      fetchedAt: Date.now(),
    }, 30);
  } catch (err) {
    if (isAbort(err)) {
      return send(res, 504, { configured: true, error: "ESPN took too long to respond (5s timeout) — try again." });
    }
    return send(res, 502, { configured: true, error: String(err && err.message) });
  }
}
