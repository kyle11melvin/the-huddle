// ============================================================================
// FantasyPros → app state, automatically. Replaces the weekly CSV paste for
// projections and ranks (docs/handoff-fantasypros-api.md).
//
// Writes the SAME shapes the pastes write — analytics.fpProj for my roster,
// fpProjIndex[week] for everyone, player.ecr + ecrIndex for ranks — so
// nothing downstream (blendProjection, the opponent side, the ledger) needs
// to know where the number came from.
//
// A paste always wins for its week. The automatic fill runs on every app
// load, so without that rule it would silently overwrite a paste made five
// minutes earlier. It also never touches matchup stars: those are not in the
// API at all, and only the CSV paste can supply them.
// ============================================================================

import { canonTeam, matchPlayer, buildEcrIndex, planEcrUpdates } from "./importer.js";
import { normName } from "./espnSync.js";
import { setPlayerAnalytics, playerAnalytics } from "./analytics.js";

export const FP_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
const APP_POS = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DST: "D/ST" };

const n = (v) => (Number.isFinite(v) ? v : 0);
const first = (s, keys) => {
  for (const k of keys) if (Number.isFinite(s[k])) return s[k];
  return null;
};

/**
 * One FantasyPros projected stat line → points under THIS league's scoring.
 *
 * Kyle's call: score every stat that earns points with the league's own
 * rules, not FantasyPros' generic PPR total — this league pays 0.2 per rush
 * attempt, which their PPR number leaves out (Gibbs, week 3: PPR 24.4,
 * league-scored 28.6). Same stat set ESPN's projection decomposes into.
 *
 * K and D/ST score on field goals, sacks and points allowed, which the
 * league scoring model does not carry, so they use FantasyPros' own total.
 * A QB line with no passing yards at all is not one we can score honestly,
 * so it falls back the same way rather than coming out near zero.
 *
 * @returns {number|null}
 */
export function scoreFpStats(stats, pos, scoring) {
  if (!stats) return null;
  const own = first(stats, ["points_ppr", "points"]);
  if (pos === "K" || pos === "DST" || pos === "D/ST") return own;
  if (pos === "QB" && !Number.isFinite(stats.pass_yds)) return own;
  const ints = first(stats, ["pass_ints", "pass_int", "ints", "int"]);
  const pts =
    n(stats.rec_rec) * scoring.reception +
    n(stats.rec_yds) * scoring.recYd +
    n(stats.rush_yds) * scoring.rushYd +
    n(stats.rush_att) * (scoring.rushAtt || 0) +
    n(stats.pass_yds) * scoring.passYd +
    n(stats.pass_tds) * scoring.passTd +
    n(ints) * scoring.int +
    (n(stats.rush_tds) + n(stats.rec_tds)) * scoring.rushRecTd;
  return Math.round(pts * 10) / 10;
}

/**
 * Fold one week's FantasyPros data into state.
 *
 * @param {object} state
 * @param {string} week
 * @param {{rank: Array, proj: Array}} data  rows from /api/fantasypros
 * @param {object} scoring  leagueScoring(state)
 * @returns {{state: object, projected: number, ranked: number, skippedForPaste: boolean}}
 */
export function applyFantasyPros(state, week, data, scoring) {
  let next = state;
  const roster = Object.values(state.players || {});

  // ---- projections ----
  const existing = (state.fpProjIndex && state.fpProjIndex[week]) || {};
  const forWeek = { ...existing };
  let projected = 0;
  const projRows = (data.proj || []).map((r) => ({ ...r, pos: APP_POS[r.pos] || r.pos }));
  for (const r of projRows) {
    const pts = scoreFpStats(r.stats, r.pos, scoring);
    if (!Number.isFinite(pts)) continue;
    const k = normName(r.name);
    if (!k) continue;
    // A pasted row carries no `src`; leave it alone.
    if (existing[k] && existing[k].src !== "api") continue;
    forWeek[k] = { proj: pts, stars: existing[k] ? existing[k].stars ?? null : null, src: "api" };
    projected++;
  }
  next = { ...next, fpProjIndex: { ...(next.fpProjIndex || {}), [week]: forWeek } };

  for (const r of projRows) {
    const pts = scoreFpStats(r.stats, r.pos, scoring);
    if (!Number.isFinite(pts)) continue;
    const { match } = matchPlayer(r.name, roster, { team: canonTeam(r.team) || r.team, pos: r.pos });
    if (!match) continue;
    const a = playerAnalytics(next, match.id, week);
    if (a && a.fpSource === "fantasypros") continue; // pasted this week — paste wins
    next = setPlayerAnalytics(next, match.id, week, { fpProj: pts, fpSource: "fantasypros-api" });
  }

  // ---- ranks ----
  let ranked = 0;
  const pastedRanks = state.ecrWeek === week && state.ecrSource === "paste";
  if (!pastedRanks && data.rank && data.rank.length) {
    const rows = data.rank.map((r) => ({ ...r, pos: APP_POS[r.pos] || r.pos, team: canonTeam(r.team) || r.team }));
    const plan = planEcrUpdates(rows, Object.values(next.players || {}));
    const players = { ...next.players };
    for (const u of plan.updates) if (players[u.id]) players[u.id] = { ...players[u.id], ecr: u.to };
    next = {
      ...next,
      players,
      ecrIndex: buildEcrIndex(rows, next.ecrIndex || {}),
      ecrWeek: week,
      ecrSource: "api",
    };
    ranked = rows.length;
  }

  return { state: next, projected, ranked, skippedForPaste: pastedRanks };
}
