// ============================================================================
// /api/fantasypros — weekly consensus ranks and projected stats, server-side.
//
//   GET /api/fantasypros?kind=rank|proj&pos=QB|RB|WR|TE|K|DST&week=1..18
//
// Replaces the weekly CSV paste (docs/handoff-fantasypros-api.md, Step 2).
// ONE position and ONE kind per request, on purpose: the plan allows 1
// request/second, so a route that fetched all twelve would need ~12s and a
// longer function limit than this project sets. The client walks the twelve
// sequentially, and the CDN caches each for 3h, so FantasyPros sees at most
// twelve calls per 3h however many devices open the app.
//
// The key lives only in the Vercel env var FANTASYPROS_API_KEY — never the
// repo, never a VITE_* var (Vite inlines those into the public bundle).
//
// Every call passes scoring=PPR explicitly: the API defaults to STD, which
// would silently disagree with everything else in the app. Projections come
// back as per-stat lines and are scored CLIENT-side with the league's own
// scoring (leagueScoring), so bonuses like 0.2/rush attempt count.
//
// Terms: personal, non-commercial, cache rather than poll, credit
// FantasyPros, and never pull their player images.
// ============================================================================

import { applyCors, rejectUnknownParams, TIMEOUT_MS, isAbort } from "./_auth.js";

const BASE = "https://api.fantasypros.com/public/v2/json/nfl";
const SEASON = process.env.FANTASYPROS_SEASON || "2026";
const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const KINDS = new Set(["rank", "proj"]);

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Consensus rankings → the fields the app reads, nothing else. */
export function trimRankings(data) {
  const players = Array.isArray(data && data.players) ? data.players : [];
  return players
    .map((p) => {
      // "RB12" → 12. The position-rank is what the app's ECR strings hold.
      const m = /(\d+)$/.exec(String(p.pos_rank || ""));
      return {
        name: p.player_name || "",
        team: p.player_team_id || "",
        pos: p.player_position_id || "",
        rank: m ? Number(m[1]) : num(p.rank_ecr),
        grade: p.start_sit_grade || null,
        opp: p.player_opponent || null,
      };
    })
    .filter((r) => r.name && Number.isFinite(r.rank));
}

/** Projections → name, team, pos and the raw numeric stat line. */
export function trimProjections(data) {
  const players = Array.isArray(data && data.players) ? data.players : [];
  return players
    .map((p) => {
      const stats = {};
      for (const [k, v] of Object.entries(p.stats || {})) {
        const n = num(v);
        if (n != null) stats[k] = n;
      }
      return { name: p.name || "", team: p.team_id || "", pos: p.position_id || "", stats };
    })
    .filter((r) => r.name && Object.keys(r.stats).length);
}

function send(res, status, body, cache) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", cache || "no-store");
  return res.status(status).send(JSON.stringify(body));
}

export default async function handler(req, res) {
  applyCors(req, res, "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  // Unknown params would fork the CDN cache key and cost real API calls —
  // the Odds API tier was nearly drained that way once.
  if (!rejectUnknownParams(req, res, ["kind", "pos", "week"])) return;

  const q = req.query || {};
  const kind = String(q.kind || "");
  const pos = String(q.pos || "").toUpperCase();
  const week = Number(q.week);
  if (!KINDS.has(kind) || !POSITIONS.has(pos) || !Number.isInteger(week) || week < 1 || week > 18) {
    return send(res, 400, { ok: false, error: "Need kind=rank|proj, pos=QB|RB|WR|TE|K|DST, week=1..18" });
  }

  const key = process.env.FANTASYPROS_API_KEY;
  if (!key) {
    return send(res, 200, { configured: false, reason: "FANTASYPROS_API_KEY is not set in Vercel." });
  }

  const path = kind === "rank" ? "consensus-rankings" : "projections";
  const url = `${BASE}/${SEASON}/${path}?position=${pos}&week=${week}&scoring=PPR`;
  try {
    const r = await fetch(url, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) {
      // Don't cache a failure at the edge — the next open should retry.
      return send(res, 502, { ok: false, error: `FantasyPros answered ${r.status}`, status: r.status });
    }
    const data = await r.json();
    const rows = kind === "rank" ? trimRankings(data) : trimProjections(data);
    return send(
      res,
      200,
      { ok: true, configured: true, kind, pos, week, rows, fetchedAt: Date.now(), updated: data.last_updated || null },
      "s-maxage=10800, stale-while-revalidate=86400"
    );
  } catch (e) {
    return send(res, 504, { ok: false, error: isAbort(e) ? "FantasyPros timed out" : "FantasyPros fetch failed" });
  }
}
