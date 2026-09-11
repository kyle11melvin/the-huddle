// ============================================================================
// FantasyPros → news wire, canonical player ids, consensus ranks.
//
// Budget: the free tier is 50 requests/DAY, an order of magnitude tighter
// than the Odds API's 500/month felt in practice, because it resets daily and
// a single bad afternoon locks the feed out until midnight UTC. So this route
// borrows odds.js's durable Blob cache wholesale: a cold edge cache costs
// zero upstream calls while the stored copy is inside its TTL, and when a
// fetch fails the last good copy is served with its age attached rather than
// an empty list.
//
// At the TTLs below the worst case is ~24 news + ~4 rankings + ~1 players
// = under 30 calls/day, and that is only if someone opens the app in every
// window. Nothing here is per-player or per-render.
//
// Terms (api.fantasypros.com/public/v2/terms-of-use): personal, non-commercial.
// Their player images require separate Sportradar permission and are NOT
// fetched — headshots in this app come from ESPN.
// ============================================================================

import { applyCors, rejectUnknownParams, TIMEOUT_MS } from "./_auth.js";
import { put, list } from "@vercel/blob";

// The base path is /public/v2/json, not /v2/json. The short form 403s with a
// message about the key, which cost a full diagnostic cycle and a subscription
// upgrade that was never the problem. Do not "simplify" this.
const BASE = "https://api.fantasypros.com/public/v2/json/nfl";

// Each resource caches under its own Blob path. The TTLs are set by how fast
// the underlying thing actually changes, not by how fresh we would like it.
const RESOURCES = {
  // Wire copy moves all day during the season.
  news: { ttlMs: 45 * 60 * 1000, path: "fp/news.json" },
  // The id map changes when someone is signed or cut. A week is generous and
  // this is the single most expensive response on the tier.
  players: { ttlMs: 7 * 24 * 60 * 60 * 1000, path: "fp/players.json" },
  // Ranks are re-cut a few times a day as news lands.
  rankings: { ttlMs: 6 * 60 * 60 * 1000, path: "fp/rankings" },
};

// `Results` is box-score recap — it is the past, and this app already knows
// what happened. Everything else carries at least one of Commentary/News, so
// those two discriminate nothing; Injury and Breaking are the signal.
const DROP_CATEGORY = "Results";
const DECISION_CATEGORIES = new Set(["Injury", "Breaking"]);

const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

async function readStored(path) {
  try {
    const { blobs } = await list({ prefix: path, limit: 1 });
    if (!blobs || !blobs.length) return null;
    const b = blobs[0];
    // Overwriting keeps the URL, and that URL is CDN-cached — without a buster
    // a read can serve the previous version straight after a write.
    const stamp = b.uploadedAt ? new Date(b.uploadedAt).getTime() : Date.now();
    const r = await fetch(`${b.url}${b.url.includes("?") ? "&" : "?"}v=${stamp}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null; // a missing or unreadable cache must never break the route
  }
}

async function writeStored(path, payload) {
  try {
    await put(path, JSON.stringify(payload), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch {
    /* storing is an optimisation — never fail the response over it */
  }
}

async function fp(path, key) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { "x-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`FantasyPros ${path.split("?")[0]} returned ${r.status}`);
  return r.json();
}

/**
 * fpid -> {name, pos, team}. Needed to put a NAME on a news item, which is
 * the only way the client can match one to a roster before canonical ids are
 * threaded through the app.
 */
async function playerIndex(key) {
  const cfg = RESOURCES.players;
  const stored = await readStored(cfg.path);
  if (stored && Date.now() - stored.fetchedAt < cfg.ttlMs) return stored;

  const data = await fp("/players?position=ALL", key);
  const rows = data.players || data.items || [];
  const byId = {};
  const byName = {};
  // FantasyPros names a defence "Pittsburgh Steelers"; this app calls it
  // "Steelers". Rather than teach the name matcher about city prefixes, a
  // D/ST is reachable by its team abbreviation, which both sides agree on.
  const byTeamDst = {};
  for (const p of rows) {
    const pos = p.position_id || (p.positions && p.positions[0]) || "";
    if (!POSITIONS.has(pos)) continue;
    const id = String(p.player_id);
    const rec = {
      name: p.player_name || "",
      pos,
      team: p.team_id || "",
      // PPR is this league's scoring. The STD rank is the API default and is
      // deliberately not carried, so nothing downstream can pick it up by
      // accident and disagree with the rest of the app.
      ecr: Number.isFinite(p.rank_ecr_ppr) && p.rank_ecr_ppr > 0 ? p.rank_ecr_ppr : null,
    };
    byId[id] = rec;
    // Duplicate names exist. First writer wins and the loser is reachable by
    // id — inventing a tie-break here is how the duplicate-name merge bug got
    // shipped the first time.
    const k = norm(rec.name);
    if (k && !byName[k]) byName[k] = id;
    if (pos === "DST" && rec.team) byTeamDst[rec.team] = id;
  }
  const payload = { fetchedAt: Date.now(), count: Object.keys(byId).length, byId, byName, byTeamDst };
  await writeStored(cfg.path, payload);
  return payload;
}

async function newsWire(key) {
  const cfg = RESOURCES.news;
  const stored = await readStored(cfg.path);
  if (stored && Date.now() - stored.fetchedAt < cfg.ttlMs) return stored;

  // One unfiltered call, filtered here. Asking the API per category would be
  // one request each and this tier does not have the room.
  const data = await fp("/news?limit=100", key);
  // The id map is cached for a week, so this join is almost always free.
  let index = null;
  try {
    index = await playerIndex(key);
  } catch {
    index = null; // news without names is still news
  }

  const items = [];
  for (const it of data.items || []) {
    const cats = Array.isArray(it.categories) ? it.categories : [];
    if (cats.includes(DROP_CATEGORY)) continue;
    const fpid = it.player_id != null ? String(it.player_id) : null;
    const rec = fpid && index ? index.byId[fpid] : null;
    items.push({
      id: it.id,
      // Every item carries the moment it was true. Undated intel implies
      // "now", which is the failure this whole block exists to avoid.
      created: it.created || null,
      fpid,
      name: rec ? rec.name : null,
      team: it.team_id || (rec && rec.team) || "",
      pos: rec ? rec.pos : "",
      title: it.title || "",
      desc: it.desc || "",
      // The analyst's read on what it means for rostered value — the part
      // that is worth more than the headline.
      impact: it.impact || "",
      link: it.link || "",
      categories: cats,
      decision: cats.some((c) => DECISION_CATEGORIES.has(c)),
    });
  }
  const payload = { fetchedAt: Date.now(), count: items.length, items };
  await writeStored(cfg.path, payload);
  return payload;
}

async function rankings(key, position, week, season) {
  const cfg = RESOURCES.rankings;
  const path = `${cfg.path}-${season}-${position}-${week}.json`;
  const stored = await readStored(path);
  if (stored && Date.now() - stored.fetchedAt < cfg.ttlMs) return stored;

  // scoring=PPR is NOT optional. The API defaults to STD, and this league is
  // PPR with bonuses — omitting it makes the ranks quietly disagree with
  // every other number in the app, which is the hardest kind of bug to see.
  const data = await fp(
    `/${season}/consensus-rankings?position=${position}&week=${week}&scoring=PPR`,
    key
  );
  const players = (data.players || []).map((p) => ({
    fpid: p.player_id != null ? String(p.player_id) : null,
    name: p.player_name || "",
    pos: p.player_position_id || "",
    team: p.player_team_id || "",
    ecr: p.rank_ecr ?? null,
    posRank: p.pos_rank || "",
    best: p.rank_min ?? null,
    worst: p.rank_max ?? null,
    sd: p.rank_std ?? null,
  }));
  const payload = { fetchedAt: Date.now(), position, week, season, count: players.length, players };
  await writeStored(path, payload);
  return payload;
}

export default async function handler(req, res) {
  applyCors(req, res, "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  // The CDN cache key is the full URL, so an unknown param is a free cache
  // miss and a fresh upstream call. On 50 requests/day that is not a rounding
  // error. Note there is deliberately no `fpid` param: per-player news would
  // be one cache entry and one request per player per render.
  if (!rejectUnknownParams(req, res, ["resource", "position", "week", "season"])) return;

  const key = process.env.FANTASYPROS_API_KEY;
  if (!key) {
    res.setHeader("Content-Type", "application/json");
    return res
      .status(200)
      .send(JSON.stringify({ configured: false, reason: "FANTASYPROS_API_KEY not set." }));
  }

  const resource = String(req.query.resource || "news");
  if (!Object.prototype.hasOwnProperty.call(RESOURCES, resource)) {
    return res
      .status(400)
      .send(JSON.stringify({ error: `unknown resource "${resource}"`, allowed: Object.keys(RESOURCES) }));
  }

  const position = String(req.query.position || "ALL").toUpperCase();
  if (!/^[A-Z]{1,4}$/.test(position)) {
    return res.status(400).send(JSON.stringify({ error: "bad position" }));
  }
  const week = String(req.query.week || "1");
  if (!/^\d{1,2}$/.test(week)) return res.status(400).send(JSON.stringify({ error: "bad week" }));
  const season = String(req.query.season || process.env.ESPN_SEASON || new Date().getUTCFullYear());
  if (!/^\d{4}$/.test(season)) return res.status(400).send(JSON.stringify({ error: "bad season" }));

  try {
    let payload;
    if (resource === "news") payload = await newsWire(key);
    else if (resource === "players") payload = await playerIndex(key);
    else payload = await rankings(key, position, week, season);

    const ttl = Math.floor(RESOURCES[resource].ttlMs / 1000);
    res.setHeader("Cache-Control", `s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`);
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(
      JSON.stringify({ configured: true, ...payload, ageMs: Date.now() - payload.fetchedAt })
    );
  } catch (err) {
    // Rate-limited, key lapsed, upstream down — serve the last good copy with
    // its age rather than nothing. Stale-but-labelled beats empty, because an
    // empty feed is indistinguishable from "no news about this player".
    const stale = await readStored(
      resource === "rankings"
        ? `${RESOURCES.rankings.path}-${season}-${position}-${week}.json`
        : RESOURCES[resource].path
    );
    if (stale) {
      res.setHeader("Cache-Control", "s-maxage=300");
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(
        JSON.stringify({
          configured: true,
          ...stale,
          served: "stale",
          ageMs: Date.now() - stale.fetchedAt,
          error: String(err && err.message),
        })
      );
    }
    return res.status(502).send(JSON.stringify({ configured: true, error: String(err && err.message) }));
  }
}
