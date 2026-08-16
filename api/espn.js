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
  // Short edge cache on successful league reads: Gameday polls every 2 min,
  // and multiple open tabs shouldn't each hammer ESPN. Post-write resyncs
  // bypass it with a ?fresh= cache-buster so drift checks never see stale.
  res.setHeader(
    "Cache-Control",
    cacheSeconds ? `s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}` : "no-store"
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

/** League's real per-stat points from mSettings — the app should never guess. */
function extractScoring(settings) {
  const items = (settings && settings.scoringSettings && settings.scoringSettings.scoringItems) || [];
  const out = {};
  for (const it of items) {
    const k = STAT_KEY[it.statId];
    if (!k) continue;
    // Some leagues store the live value in pointsOverrides["16"] (PPR slot).
    const override = it.pointsOverrides && Number(it.pointsOverrides["16"]);
    const pts = Number.isFinite(override) && override !== 0 ? override : it.points;
    if (Number.isFinite(pts)) out[k] = pts;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

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

  const week = req.query.week ? `&scoringPeriodId=${encodeURIComponent(req.query.week)}` : "";
  const url = `${BASE}/${season}/segments/0/leagues/${leagueId}?${VIEWS.map((v) => `view=${v}`).join("&")}${week}`;

  const headers = { Accept: "application/json" };
  if (swid && s2) headers.Cookie = `SWID=${swid}; espn_s2=${s2}`;

  // Weekly projection extractor. ESPN mixes season totals and single-week
  // projections in the same stats array; grabbing the wrong one made Tyreek
  // Hill "project" 273 points in a week. statSplitTypeId 1 = one week.
  const weeklyProj = (p, currentPeriod) => {
    const stats = p.stats || [];
    const wk =
      stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === currentPeriod) ||
      stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 1);
    if (wk) return Math.round((wk.appliedTotal || 0) * 10) / 10;
    // only a season projection exists → per-game baseline, same scale
    const season = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0);
    if (season && season.appliedTotal > 0) return Math.round((season.appliedTotal / 17) * 10) / 10;
    return null;
  };

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
    }
  )
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  try {
    const r = await fetch(url, { headers, cache: "no-store" });
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
          proj: weeklyProj(p, data.scoringPeriodId),
          actual: realStat ? Math.round((realStat.appliedTotal || 0) * 10) / 10 : null,
        };
      }),
    }));

    // This week's head-to-head pairings, so the simulator knows who you face.
    const currentWeek = data.scoringPeriodId;
    const matchups = (data.schedule || [])
      .filter((m) => m.matchupPeriodId === data.status?.currentMatchupPeriod)
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
      { cache: "no-store" }
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
          proj: weeklyProj(p, data.scoringPeriodId),
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
    return send(res, 502, { configured: true, error: String(err && err.message) });
  }
}
