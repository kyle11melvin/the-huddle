// ============================================================================
// Full-season NFL schedule, from ESPN's public scoreboard (no auth).
//
// One payload powers several "intelligence" features at once:
//   - bye weeks derived automatically (a week with no game = bye) — this
//     retires manual bye entry, which existed only because inventing a
//     schedule would have been worse than nothing
//   - every player's opponent for every week, filled without typing
//   - upcoming-schedule context ("next 3: @PIT, TB, @NO")
//
// Cached hard at the edge: the NFL schedule changes ~never mid-season.
// ============================================================================

import { applyCors, rejectUnknownParams, TIMEOUT_MS } from "./_auth.js";

const WEEKS = 18;
// 18 simultaneous requests is a burst ESPN can rate-limit (and every 429 is
// a null week, which is exactly what poisons the bye derivation).
const CONCURRENCY = 4;

const FIX = { WAS: "WSH", JAC: "JAX", LA: "LAR" };
const fixAbbr = (a) => FIX[a] || a;

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

export default async function handler(req, res) {
  applyCors(req, res, "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  // Same cache-key reasoning as /api/odds: an unknown param is a free cache
  // miss, and each miss fires a full 18-week ESPN sweep.
  if (!rejectUnknownParams(req, res, [])) return;

  const season = process.env.ESPN_SEASON || "2026";

  try {
    const weekPayloads = await mapLimit(
      Array.from({ length: WEEKS }, (_, i) => i + 1),
      CONCURRENCY,
      (wk) =>
        fetch(
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${wk}&dates=${season}`,
          { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) }
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
    );

    // opps[week][ABBR] = "OPP" or "@OPP"
    const opps = {};
    const teamsSeen = new Set();
    weekPayloads.forEach((data, i) => {
      const wk = String(i + 1);
      opps[wk] = {};
      for (const ev of (data && data.events) || []) {
        const comp = ev.competitions && ev.competitions[0];
        if (!comp) continue;
        const home = comp.competitors?.find((c) => c.homeAway === "home");
        const away = comp.competitors?.find((c) => c.homeAway === "away");
        const h = home && fixAbbr(home.team?.abbreviation);
        const a = away && fixAbbr(away.team?.abbreviation);
        if (!h || !a) continue;
        opps[wk][h] = a;
        opps[wk][a] = `@${h}`;
        teamsSeen.add(h);
        teamsSeen.add(a);
      }
    });

    // bye = the regular-season week a team simply doesn't appear
    const byes = {};
    for (const team of teamsSeen) {
      for (let w = 1; w <= WEEKS; w++) {
        if (!opps[String(w)][team]) {
          byes[team] = w;
          break;
        }
      }
    }

    const populatedWeeks = Object.values(opps).filter((w) => Object.keys(w).length > 0).length;
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(
      JSON.stringify({
        season,
        populatedWeeks,
        // Preseason: ESPN may not have the full slate posted yet — the client
        // treats a sparse schedule as "not available" rather than truth.
        complete: populatedWeeks >= 17 && teamsSeen.size >= 30,
        opps,
        byes,
        fetchedAt: Date.now(),
      })
    );
  } catch (err) {
    return res.status(502).send(JSON.stringify({ error: String(err && err.message) }));
  }
}
