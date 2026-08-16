// ============================================================================
// ESPN lineup write — the adapter. All write logic lives in this one file so
// an ESPN endpoint change is a one-file fix.
//
// Built against a payload captured live from Kyle's own browser (2026-08-16,
// 200 OK): POST lm-api-writes.../leagues/{id}/transactions/ with
// { isLeagueManager, teamId, type:"ROSTER", memberId:<SWID>, scoringPeriodId,
//   executionType:"EXECUTE", items:[{playerId, type:"LINEUP",
//   fromLineupSlotId, toLineupSlotId}] }
//
// Guardrails run HERE, server-side, against fresh ESPN state — never the
// client's cached picture:
//   1. roster re-fetched; every item must match its claimed current slot
//      (drift check — the user may have moved players in ESPN's own app)
//   2. per-player kickoff locks: any player whose NFL game is live or final
//      is rejected before ESPN is ever called
//   3. both sides of a swap ship in ONE transaction (atomic)
// ============================================================================

const READ = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
const WRITE = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons";
// Captured build hash — tried as fallback if the bare call is rejected.
const PLATFORM_VERSION = "03952a53323901871b54cebc123891a6966b3143";

function send(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(body));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  const leagueId = process.env.ESPN_LEAGUE_ID;
  const season = process.env.ESPN_SEASON || "2026";
  const swid = process.env.ESPN_SWID;
  const s2 = process.env.ESPN_S2;
  if (!leagueId || !swid || !s2) {
    return send(res, 200, { ok: false, error: "ESPN credentials not configured on the server." });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return send(res, 400, { ok: false, error: "Bad request body" });
  }
  const items = Array.isArray(body && body.items) ? body.items : [];
  if (!items.length || items.length > 2) {
    return send(res, 400, { ok: false, error: "Expected 1–2 lineup items (one swap)." });
  }
  for (const it of items) {
    if (!Number.isFinite(Number(it.playerId)) || !Number.isFinite(it.fromSlot) || !Number.isFinite(it.toSlot)) {
      return send(res, 400, { ok: false, error: "Each item needs playerId, fromSlot, toSlot." });
    }
  }

  const cookie = `SWID=${swid}; espn_s2=${s2}`;
  const headers = { Accept: "application/json", Cookie: cookie };

  try {
    // ---- fresh state: roster + team id ----
    const leagueR = await fetch(`${READ}/${season}/segments/0/leagues/${leagueId}?view=mRoster&view=mTeam`, {
      headers,
      cache: "no-store",
    });
    if (!leagueR.ok) return send(res, 502, { ok: false, error: `ESPN read failed (${leagueR.status}) — cookies may have expired.` });
    const league = await leagueR.json();

    // Locks come from REGULAR-SEASON games of the week being edited — the
    // bare scoreboard URL returns whatever ESPN's "today" is (a just-played
    // preseason slate locked the entire league by mistake).
    const lockWeek = body.scoringPeriodId || league.scoringPeriodId || 1;
    const sbR = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${lockWeek}&dates=${season}`,
      { cache: "no-store" }
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    // my team = the one owned by this SWID
    const me = (league.teams || []).find((t) => (t.owners || []).some((o) => String(o).toUpperCase() === String(swid).toUpperCase()));
    if (!me) return send(res, 400, { ok: false, error: "Couldn't find a team owned by this ESPN account." });

    const entries = (me.roster && me.roster.entries) || [];
    // ESPN's transaction endpoint only accepts the CURRENT scoring period
    // (verified: sending week 2 during week 1 → 409 "Transaction type can
    // only be executed in the current scoring period").
    const scoringPeriodId = league.scoringPeriodId;
    if (body.scoringPeriodId && body.scoringPeriodId !== scoringPeriodId) {
      return send(res, 409, {
        ok: false,
        error: `ESPN only accepts live lineup changes for the current week (week ${scoringPeriodId}). Flip the week selector back to make real moves — future weeks are local planning only.`,
      });
    }

    // per-team game state from the scoreboard
    const gameState = {};
    for (const ev of (sbR && sbR.events) || []) {
      const comp = ev.competitions && ev.competitions[0];
      const st = (comp && comp.status && comp.status.type && comp.status.type.state) || "pre";
      for (const c of (comp && comp.competitors) || []) {
        const ab = c.team && c.team.abbreviation;
        if (ab) gameState[ab === "WAS" ? "WSH" : ab === "JAC" ? "JAX" : ab] = st;
      }
    }
    const PRO = { 1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WSH",29:"CAR",30:"JAX",33:"BAL",34:"HOU" };

    // ---- guardrails ----
    for (const it of items) {
      const pid = Number(it.playerId);
      const entry = entries.find((e) => e.playerId === pid || (e.playerPoolEntry && e.playerPoolEntry.player && e.playerPoolEntry.player.id === pid));
      if (!entry) return send(res, 409, { ok: false, error: `Player ${pid} is not on your ESPN roster — roster drifted, refresh and retry.` });
      if (entry.lineupSlotId !== it.fromSlot) {
        return send(res, 409, {
          ok: false,
          error: "Roster changed on ESPN since this screen loaded — refresh and retry.",
          drift: { playerId: pid, expectedSlot: it.fromSlot, actualSlot: entry.lineupSlotId },
        });
      }
      const p = entry.playerPoolEntry && entry.playerPoolEntry.player;
      const abbr = p && PRO[p.proTeamId];
      const st = abbr && gameState[abbr];
      if (st === "in" || st === "post") {
        return send(res, 423, { ok: false, error: `${(p && p.fullName) || "That player"} is locked — his game has ${st === "in" ? "started" : "finished"}.` });
      }
    }

    // ---- the transaction (both items, one atomic call) ----
    const payload = {
      isLeagueManager: false,
      teamId: me.id,
      type: "ROSTER",
      memberId: swid,
      scoringPeriodId,
      executionType: "EXECUTE",
      items: items.map((it) => ({
        playerId: Number(it.playerId),
        type: "LINEUP",
        fromLineupSlotId: it.fromSlot,
        toLineupSlotId: it.toSlot,
      })),
    };

    const post = (qs) =>
      fetch(`${WRITE}/${season}/segments/0/leagues/${leagueId}/transactions/${qs}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
      });

    let w = await post("");
    if (!w.ok && w.status !== 409) w = await post(`?platformVersion=${PLATFORM_VERSION}`);

    const text = await w.text().catch(() => "");
    console.log("espn-write", JSON.stringify({ ok: w.ok, status: w.status, payload, resp: text.slice(0, 300) }));

    if (!w.ok) {
      let espnMsg = "";
      try {
        espnMsg = (JSON.parse(text).messages || [])[0] || "";
      } catch {
        /* non-JSON */
      }
      return send(res, 502, {
        ok: false,
        error: espnMsg ? `ESPN: ${espnMsg}` : `ESPN rejected the move (${w.status}).`,
        detail: text.slice(0, 200),
      });
    }
    return send(res, 200, { ok: true, teamId: me.id, scoringPeriodId });
  } catch (err) {
    return send(res, 502, { ok: false, error: String(err && err.message) });
  }
}
