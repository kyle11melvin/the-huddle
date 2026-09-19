// ============================================================================
// State -> PlayerCard props.
//
// Pure and separate from the component so the card can be asserted on without
// rendering, and so the modal and the screenshot harness feed it from the same
// place. The card renders whatever it is handed; this file decides what the
// app actually knows.
//
// Every field returns null rather than a plausible-looking zero when the
// underlying data is missing. Absent is the common case — the DvP model has no
// game logs in week 1, and the book spread is not stored at all — and a tile
// reading 0.0 when it means "unknown" is the failure mode this project keeps
// running into.
// ============================================================================

import { propsSweptFor, pointDistribution, playerAnalytics } from "./analytics.js";
import { DEFAULT_PROJ_WEIGHTS } from "./analytics.js";

/** Statuses meaning "may not take the field" — a season rank stops applying. */
const DOUBTFUL = new Set(["D", "O", "IR"]);

/**
 * pointDistribution().source -> a short label and its qualifier.
 *
 * This replaces the matchup tile. Matchup stars have no automatic source —
 * FantasyPros exposes no matchup/SOS/DvP endpoint, ESPN publishes no DvP
 * rating, and a computed one needs opponent-adjusted game logs that will not
 * exist until roughly Week 4. So the tile read "no data" for nearly every
 * player and was dead space in the most valuable row on the card.
 *
 * What goes there instead is the one thing the app knows about every player
 * and never showed: WHICH SOURCE produced his projection. That is the card's
 * whole thesis — props outrank opinion — so saying whether this number came
 * from the market or from consensus tells you how much weight it carries.
 * When the Odds API budget runs out, this is also the tile that explains why
 * the props box went empty.
 */
function sourceOf(dist) {
  if (!dist || !dist.source) return null;
  const raw = String(dist.source);
  const base = raw.split(/\s*[×·]\s*/)[0].trim();
  const qual = raw.slice(base.length).replace(/^\s*[×·]\s*/, "").trim();
  let label = "ESPN";
  if (/vegas props/i.test(base)) label = "PROPS";
  else if (/blend/i.test(base)) label = "ESPN+FP";
  else if (/fantasypros/i.test(base)) label = "FP";
  else if (/season average/i.test(base)) label = "SEASON";
  else if (/projects zero/i.test(base)) label = "ESPN 0";
  return {
    label,
    // Market-derived is the edge; everything else is opinion. Gold marks it.
    edge: label === "PROPS",
    detail: qual || (dist.confident ? "sources agree" : "wide spread"),
  };
}

/**
 * 1-5 matchup stars -> a word describing THE MATCHUP.
 *
 * Deliberately not a letter grade. A letter next to "RB2" reads as a verdict on
 * the PLAYER — the app appearing to call the second-best back in football a D —
 * when what it means is that he draws a defense that guts running backs. Naming
 * the opponent read instead makes that unmistakable.
 */
const MATCHUP_WORD = { 1: "BRUTAL", 2: "TOUGH", 3: "NEUTRAL", 4: "GOOD", 5: "SMASH" };

/**
 * The props edge: how much the market disagrees with expert projections.
 *
 * Measured against the ESPN+FP blend rather than against nothing, because the
 * blend is what the projection WOULD have been. A props number that merely
 * agrees with consensus is not an edge, and should read near zero.
 */
function propsEdgeFrom(a, weights) {
  if (!a || !Number.isFinite(a.propsProj) || a.propsProj <= 0) return null;
  const espn = Number.isFinite(a.proj) ? a.proj : null;
  const fp = Number.isFinite(a.fpProj) ? a.fpProj : null;
  let baseline = null;
  if (espn != null && fp != null) {
    const w = weights || DEFAULT_PROJ_WEIGHTS;
    baseline = espn * w.espn + fp * w.fp;
  } else if (fp != null) baseline = fp;
  else if (espn != null) baseline = espn;
  if (baseline == null) return null;

  const parts = Array.isArray(a.propsParts) ? a.propsParts.map(([label]) => label) : [];
  return {
    delta: Math.round((a.propsProj - baseline) * 10) / 10,
    parts,
    source: a.propsSource || null,
  };
}

/**
 * @param {object} state  app state
 * @param {object} player the player record
 * @param {string} week
 * @returns {object|null} props for <PlayerCard>, or null without a player
 */
export function playerCardData(state, player, week) {
  if (!player) return null;
  const a = playerAnalytics(state, player.id, week);
  const dist = pointDistribution(player, week, state);
  const wd = (player.weeks && player.weeks[week]) || {};
  const status = player.status || "";

  // Stars are the only matchup signal that exists today. The schedule-adjusted
  // opponent-defense rating docs/DESIGN.md specifies is NOT built — so this is
  // labelled as stars rather than dressed up as something it isn't.
  const stars = Number.isFinite(wd.matchup) ? wd.matchup : Number.isFinite(a && a.matchupStars) ? a.matchupStars : null;
  // NO `points` FIELD, on purpose. The card used to print "+2.1 pts" beside
  // this, which was fiction: matchupStars does not enter pointDistribution()
  // at all. The only place it moves a number is the rank fallback in
  // analysis.js, which zero players on a synced roster ever reach. Worse, the
  // projection leads with Vegas props — and the book has ALREADY priced the
  // opponent — so a matchup adjustment on top would penalise a player twice
  // for the same defense. It is a read, not a contribution, and says so.
  const matchup =
    stars == null
      ? null
      : {
          grade: MATCHUP_WORD[Math.max(1, Math.min(5, Math.round(stars)))],
          detail: `${stars}/5${wd.opp ? ` · ${wd.opp}` : ""}`,
        };

  const implied = state.espn && state.espn.impliedTotals && player.team ? state.espn.impliedTotals[player.team] : null;

  return {
    player: {
      name: player.name,
      pos: player.pos,
      team: player.team,
      opp: wd.opp || null,
      status,
      espnId: player.espnId || "",
    },
    dist: dist
      ? { mean: dist.mean, condMean: dist.condMean, sd: dist.sd, playProb: dist.playProb }
      : null,
    propsEdge: propsEdgeFrom(a, state.projWeights),
    propsSwept: propsSweptFor(state, week),
    source: sourceOf(dist),
    matchup,
    consensus: player.ecr
      ? { rank: player.ecr, sources: 1, spread: 0, stale: DOUBTFUL.has(status) }
      : null,
    // The book SPREAD is not stored anywhere — only the implied team total
    // survives the ESPN sync. Showing the total and saying so beats inventing
    // a spread or leaving the tile silently blank.
    book: Number.isFinite(implied) ? { spread: `${implied}`, total: null, implied } : null,
    // No per-player news feed exists. api/news.js is a league-wide wire.
    news: [],
  };
}
