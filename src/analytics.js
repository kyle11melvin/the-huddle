// ============================================================================
// Per-player, per-week analytics — the inputs a projection needs.
//
// Stored at state.analytics[playerId][week]:
//   { proj, seasonAvg, propsProj, props{}, expertRanks[] }
//
// Everything here is either pasted in or derived from what was pasted. Where a
// number is a heuristic rather than a measurement, it says so — the point of
// this app is to be right, not to look confident.
// ============================================================================

export function playerAnalytics(state, playerId, week) {
  return (state.analytics && state.analytics[playerId] && state.analytics[playerId][week]) || null;
}

export function setPlayerAnalytics(state, playerId, week, patch) {
  const analytics = { ...(state.analytics || {}) };
  const forPlayer = { ...(analytics[playerId] || {}) };
  forPlayer[week] = { ...(forPlayer[week] || {}), ...patch, updatedAt: Date.now() };
  analytics[playerId] = forPlayer;
  return { ...state, analytics };
}

// --------------------------------------------------------------- dispersion ---

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Expert-rank spread. The headline insight: everyone averages these ranks and
 * throws the disagreement away, but the disagreement IS the uncertainty signal.
 * A player ranked 22–29 across seven experts is a known quantity; one ranked
 * 50–94 is a coin flip the market hasn't priced.
 */
export function rankDispersion(expertRanks) {
  const ranks = (expertRanks || []).map((r) => r.rank).filter((n) => Number.isFinite(n));
  if (ranks.length < 2) return null;
  const lo = Math.min(...ranks);
  const hi = Math.max(...ranks);
  const sd = stdev(ranks);
  const med = median(ranks);
  const avg = mean(ranks);

  // Measured as a coefficient of variation, not raw rank points, because the
  // same 7-rank spread means very different things at #25 and at #3. Ranks
  // 22–29 is a settled market; 50–94 is nobody having any idea.
  const cv = avg > 0 ? sd / avg : 0;
  const spread = Math.min(1, cv / 0.3);

  return { count: ranks.length, lo, hi, median: med, sd: Math.round(sd * 10) / 10, cv, spread };
}

export function consensusLabel(disp) {
  if (!disp) return { text: "no data", tone: "dim" };
  if (disp.spread < 0.4) return { text: "strong consensus", tone: "good" };
  if (disp.spread < 0.7) return { text: "some disagreement", tone: "mid" };
  return { text: "market is split", tone: "bad" };
}

// ------------------------------------------------------- point distributions ---

/**
 * Week-to-week volatility by position, as a coefficient of variation.
 * HEURISTIC, not fitted: these are round numbers in line with how erratic each
 * position is known to be. They set the SHAPE of the simulation, so treat the
 * output as directional until real game logs replace them.
 */
const BASE_CV = { QB: 0.32, RB: 0.5, WR: 0.58, TE: 0.6, K: 0.42, "D/ST": 0.72 };

/**
 * Injury designations as play probabilities. Q/D outcomes are BIMODAL — the
 * player either suits up and produces a roughly normal game, or sits and
 * scores exactly zero. A flat points penalty models neither branch; a mixture
 * does. Rates are the long-run league-wide rates for each tag.
 */
export const PLAY_PROB = { Q: 0.77, D: 0.25, O: 0, IR: 0 };

export const playProbFor = (player) =>
  player && player.status in PLAY_PROB ? PLAY_PROB[player.status] : 1;

/**
 * Turn what we know about a player into a distribution of fantasy points.
 * @returns {{mean:number, condMean:number, sd:number, playProb:number,
 *            source:string, confident:boolean}|null}
 * `mean` is the EXPECTED points (playProb × conditional mean) — the honest
 * headline number. `condMean`/`sd` describe the if-he-plays branch, which is
 * what the simulator samples from (with prob playProb, else 0).
 */
export function pointDistribution(player, week, state) {
  if (!player) return null;
  const a = playerAnalytics(state, player.id, week);
  const cv = BASE_CV[player.pos] ?? 0.55;
  const implied = state.espn && state.espn.impliedTotals;

  let mu = null;
  let source = "";
  // Priority order, not a blend: money-backed lines outrank expert opinion.
  if (a && Number.isFinite(a.propsProj) && a.propsProj > 0) {
    mu = a.propsProj;
    source = "vegas props";
  } else if (a && Number.isFinite(a.proj) && (a.proj > 0 || a.projSource === "espn")) {
    // An explicit ESPN zero is authoritative (bye / ruled out) and must NOT
    // fall through to a season average — that's how a player who will score
    // nothing ends up projected for his season mean. A zero from any other
    // source is still treated as "no number".
    mu = a.proj;
    source = a.proj === 0 ? "ESPN projects zero" : "projection";
  } else if (a && Number.isFinite(a.seasonAvg) && a.seasonAvg > 0) {
    mu = a.seasonAvg;
    source = "season average";
  }
  if (mu == null) return null;

  // Game lines tilt expert projections toward the market: players in
  // high-total games get nudged up, low-total down. Capped ±12% — the line
  // prices the game environment, not the player's share of it. Props are
  // already the market, so they're never re-adjusted.
  if (source !== "vegas props" && implied && Number.isFinite(implied[player.team])) {
    const vals = Object.values(implied).filter(Number.isFinite);
    if (vals.length >= 4) {
      const avg = vals.reduce((n, v) => n + v, 0) / vals.length;
      const factor = Math.max(0.88, Math.min(1.12, implied[player.team] / avg));
      if (Math.abs(factor - 1) > 0.005) {
        mu *= factor;
        source = `${source} × vegas line`;
      }
    }
  }

  // Disagreement widens the distribution. Two automatic sources: pasted
  // expert-rank spread (legacy), and — better — the gap between the Vegas
  // number and ESPN's model. Two independent estimators disagreeing IS the
  // uncertainty, no experts required.
  const disp = rankDispersion(a && a.expertRanks);
  let uncertainty = disp ? 1 + disp.spread * 0.5 : 1;
  if (a && Number.isFinite(a.propsProj) && Number.isFinite(a.proj) && a.proj > 0 && a.propsProj > 0) {
    const gap = Math.abs(a.propsProj - a.proj) / ((a.propsProj + a.proj) / 2);
    uncertainty = Math.max(uncertainty, 1 + Math.min(0.5, gap));
  }
  const sd = mu * cv * uncertainty;

  // Injury risk prices in here, not as a points penalty downstream.
  const playProb = playProbFor(player);
  if (playProb < 1) source = `${source} × ${player.status} risk`;

  return {
    mean: Math.round(mu * playProb * 10) / 10,
    condMean: Math.round(mu * 10) / 10,
    sd: Math.round(sd * 10) / 10,
    playProb,
    source,
    confident: !!(disp && disp.spread < 0.4),
    dispersion: disp,
  };
}

/** Floor/ceiling as ~10th and ~90th percentile of that distribution. */
export function floorCeiling(dist) {
  if (!dist) return null;
  // With a real chance of not playing, the floor IS zero — that's the point
  // of modelling Q/D as bimodal instead of shaving the projection.
  const floor = dist.playProb != null && dist.playProb < 0.9
    ? 0
    : Math.max(0, Math.round(((dist.condMean ?? dist.mean) - 1.28 * dist.sd) * 10) / 10);
  return {
    floor,
    ceiling: Math.round(((dist.condMean ?? dist.mean) + 1.28 * dist.sd) * 10) / 10,
  };
}

/** How much analytics coverage exists for a given week. */
export function analyticsCoverage(state, week) {
  const ids = Object.keys(state.players || {});
  let withProj = 0;
  for (const id of ids) {
    const a = playerAnalytics(state, id, week);
    if (a && Number.isFinite(a.proj) && a.proj > 0) withProj++;
  }
  return { withProj, total: ids.length };
}
