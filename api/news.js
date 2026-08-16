// ============================================================================
// NFL news wire (ESPN public feed, keyless). Beat-report aggregation: camp
// buzz, injuries, depth-chart moves — the raw material for sleeper spotting.
// The client cross-references headlines against the league player pool, so a
// story about a 5%-rostered back surfaces as a flagged sleeper, not noise.
// ============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50", {
      cache: "no-store",
    });
    if (!r.ok) return res.status(502).send(JSON.stringify({ error: `ESPN news returned ${r.status}` }));
    const data = await r.json();

    const items = (data.articles || []).map((a) => ({
      headline: a.headline || "",
      description: a.description || "",
      published: a.published || "",
      link: (a.links && a.links.web && a.links.web.href) || "",
      // athlete ids let the client match stories to specific players
      athleteIds: (a.categories || [])
        .filter((c) => c.type === "athlete" && c.athleteId)
        .map((c) => String(c.athleteId)),
      teams: (a.categories || [])
        .filter((c) => c.type === "team" && c.team && c.team.abbreviation)
        .map((c) => (c.team.abbreviation === "WAS" ? "WSH" : c.team.abbreviation)),
    }));

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify({ items, fetchedAt: Date.now() }));
  } catch (err) {
    return res.status(502).send(JSON.stringify({ error: String(err && err.message) }));
  }
}
