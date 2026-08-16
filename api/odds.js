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

const BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl";
const MARKETS = "player_reception_yds,player_receptions,player_rush_yds,player_pass_yds,player_pass_tds,player_anytime_td";
const MARKET_KEY = {
  player_reception_yds: "recYds",
  player_receptions: "receptions",
  player_rush_yds: "rushYds",
  player_pass_yds: "passYds",
  player_pass_tds: "passTds",
};

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const key = process.env.ODDS_API_KEY;
  if (!key) {
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify({ configured: false, reason: "ODDS_API_KEY not set." }));
  }

  try {
    const evR = await fetch(`${BASE}/events?apiKey=${key}`, { cache: "no-store" });
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

    for (const ev of soon) {
      const r = await fetch(
        `${BASE}/events/${ev.id}/odds?apiKey=${key}&regions=us&markets=${MARKETS}&oddsFormat=american`,
        { cache: "no-store" }
      );
      remaining = r.headers.get("x-requests-remaining") || remaining;
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
        players: [...players.values()].filter((p) => Object.keys(p.props).length > 0),
        remaining,
        fetchedAt: Date.now(),
      })
    );
  } catch (err) {
    return res.status(502).send(JSON.stringify({ configured: true, error: String(err && err.message) }));
  }
}
