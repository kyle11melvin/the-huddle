// ============================================================================
// The Odds API → player props, automated. Kyle's doctrine: money-backed lines
// outrank every expert projection, and nobody should paste anything.
//
// Credit budget (free tier = 500/mo): the events list is free; each event's
// props call costs markets × regions = 6 credits → ~90 per full sweep. The
// edge cache (6h) means at most ~4 sweeps/day league-wide, and realistically
// 1-2 — comfortably inside budget. `x-requests-remaining` is passed through
// so the client can surface it.
// ============================================================================

import { applyCors, rejectUnknownParams, TIMEOUT_MS, isAbort } from "./_auth.js";

const BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl";
// Stop sweeping when the month's credits get this low. The sweep is an
// enhancement; being unable to price ANY player for the rest of the month
// because one afternoon drained the tier is the failure worth avoiding.
const CREDIT_FLOOR = 50;
const MARKETS = "player_reception_yds,player_receptions,player_rush_yds,player_rush_attempts,player_pass_yds,player_pass_tds,player_anytime_td";
const MARKET_KEY = {
  player_reception_yds: "recYds",
  player_receptions: "receptions",
  player_rush_yds: "rushYds",
  player_rush_attempts: "rushAtt", // league scores 1 pt / 5 attempts
  player_pass_yds: "passYds",
  player_pass_tds: "passTds",
};

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

export default async function handler(req, res) {
  applyCors(req, res, "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  // The edge cache is this route's entire budget guard, and the CDN cache key
  // is the full URL — so an unknown param is a free cache miss and a fresh
  // ~90-credit sweep. This route takes no params at all.
  if (!rejectUnknownParams(req, res, [])) return;

  const key = process.env.ODDS_API_KEY;
  if (!key) {
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify({ configured: false, reason: "ODDS_API_KEY not set." }));
  }

  try {
    const evR = await fetch(`${BASE}/events?apiKey=${key}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!evR.ok) {
      return res.status(502).send(JSON.stringify({ configured: true, error: `Odds API events returned ${evR.status}` }));
    }
    const events = await evR.json();

    // upcoming games only, capped to one week's slate
    const now = Date.now();
    const soon = (events || [])
      .filter((e) => {
        const t = Date.parse(e.commence_time);
        return t > now - 4 * 3600e3 && t < now + 8 * 24 * 3600e3;
      })
      .slice(0, 16);

    const players = new Map(); // norm name -> {name, props}
    let remaining = null;
    let partial = false;
    let swept = 0;

    for (const ev of soon) {
      // Bail before spending, not after: each event costs ~7 credits, so a
      // sweep that starts under the floor could push the tier to zero and
      // take the rest of the month's pricing down with it.
      if (remaining != null && Number(remaining) < CREDIT_FLOOR) {
        partial = true;
        break;
      }
      const r = await fetch(
        `${BASE}/events/${ev.id}/odds?apiKey=${key}&regions=us&markets=${MARKETS}&oddsFormat=american`,
        { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) }
      ).catch((e) => {
        if (isAbort(e)) return null; // one slow event shouldn't sink the sweep
        throw e;
      });
      if (!r) {
        partial = true;
        continue;
      }
      remaining = r.headers.get("x-requests-remaining") || remaining;
      swept++;
      if (!r.ok) continue; // a single event without props shouldn't kill the sweep
      const data = await r.json();

      // prefer one steady book so lines are internally consistent
      const books = data.bookmakers || [];
      const book = books.find((b) => b.key === "draftkings") || books.find((b) => b.key === "fanduel") || books[0];
      if (!book) continue;

      for (const market of book.markets || []) {
        for (const o of market.outcomes || []) {
          const pname = o.description || (market.key === "player_anytime_td" ? o.name : null);
          if (!pname || pname === "Over" || pname === "Under") continue;
          const k = norm(pname);
          if (!players.has(k)) players.set(k, { name: pname, props: {} });
          const rec = players.get(k);
          if (market.key === "player_anytime_td") {
            if (o.name !== "No" && Number.isFinite(o.price)) rec.props.anytimeTdOdds = o.price;
          } else if (MARKET_KEY[market.key]) {
            // the Over side carries the line
            if (o.name === "Over" && Number.isFinite(o.point)) rec.props[MARKET_KEY[market.key]] = o.point;
          }
        }
      }
    }

    // 6h edge cache — this is what keeps the free tier alive
    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=43200");
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(
      JSON.stringify({
        configured: true,
        events: soon.length,
        eventsSwept: swept,
        // true = we stopped early (credit floor or a timeout); the players
        // below are real, the set is just incomplete.
        partial,
        players: [...players.values()].filter((p) => Object.keys(p.props).length > 0),
        remaining,
        fetchedAt: Date.now(),
      })
    );
  } catch (err) {
    if (isAbort(err)) {
      return res.status(504).send(JSON.stringify({ configured: true, error: "Odds API timed out (5s)." }));
    }
    return res.status(502).send(JSON.stringify({ configured: true, error: String(err && err.message) }));
  }
}
