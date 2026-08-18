// ============================================================================
// Projection calibration ledger.
//
// Every number this app shows inherits the error in three hand-picked
// constants — BASE_CV, PLAY_PROB and TEAM_LOAD — which analytics.js and
// simulate.js both label in comments as directional heuristics awaiting real
// game logs. This is where those game logs come from.
//
// The capture rule is the whole design:
//
//   BEFORE kickoff  — keep refreshing the projection. Props post late, injury
//                     news lands Sunday morning; the number keeps improving.
//   AT kickoff      — FREEZE it. Grading a projection that was revised after
//                     the game started would flatter the model with hindsight.
//   AT final        — record the actual.
//
// The analysis can wait for the offseason. The capture cannot: a week that
// goes ungraded is gone, so this has to be running from week 1.
// ============================================================================

import { pointDistribution, playerAnalytics, DEFAULT_PROJ_WEIGHTS } from "./analytics.js";
import { normName } from "./espnSync.js";

/** Kickoff state for a player's NFL team: 'pre' | 'in' | 'post' | null. */
const gameStateFor = (state, team) => {
  const g = state.espn && state.espn.games && state.espn.games[team];
  return g ? g.state : null;
};

/** My live roster entries from the latest sync, indexed for actual-points lookup. */
function myEntries(state) {
  const espn = state.espn;
  if (!espn || !espn.teams) return new Map();
  const me = espn.teams.find((t) => t.id === espn.myTeamId);
  const out = new Map();
  for (const e of (me && me.roster) || []) {
    if (e.espnId) out.set(String(e.espnId), e);
    out.set(normName(e.name), e);
  }
  return out;
}

/**
 * Fold this week's projections and results into state.calibration.
 * Pure: returns the next calibration map, never mutates.
 *
 * @returns {{calibration: object, captured: number, graded: number}}
 */
export function captureCalibration(state, week) {
  const wk = String(week);
  // "PRE" and other non-numeric weeks aren't gradeable.
  if (!Number.isFinite(Number(wk))) {
    return { calibration: state.calibration || {}, captured: 0, graded: 0 };
  }

  const prev = state.calibration || {};
  const forWeek = { ...(prev[wk] || {}) };
  const entries = myEntries(state);
  let captured = 0;
  let graded = 0;

  for (const p of Object.values(state.players || {})) {
    const existing = forWeek[p.id];
    const gs = gameStateFor(state, p.team);
    const started = gs === "in" || gs === "post";

    // ---- projection side ----
    if (!existing || !existing.locked) {
      const dist = pointDistribution(p, wk, state);
      if (dist) {
        const a = playerAnalytics(state, p.id, wk) || {};
        forWeek[p.id] = {
          ...(existing || {}),
          name: p.name,
          pos: p.pos,
          team: p.team,
          proj: dist.mean,
          condMean: dist.condMean,
          sd: dist.sd,
          playProb: dist.playProb,
          source: dist.source,
          // EACH source recorded separately against the one actual. This is
          // what lets the weighting stop being an assumption in December.
          sources: {
            espn: Number.isFinite(a.proj) ? a.proj : null,
            espnBasis: a.projBasis || null,
            fp: Number.isFinite(a.fpProj) ? a.fpProj : null,
            props: Number.isFinite(a.propsProj) ? a.propsProj : null,
          },
          stars: Number.isFinite(a.matchupStars) ? a.matchupStars : null,
          status: p.status || "",
          // Frozen the moment the ball is kicked — see the header note.
          locked: started,
          lockedAt: started ? Date.now() : null,
        };
        captured++;
      }
    }

    // ---- result side ----
    if (gs === "post" && forWeek[p.id] && forWeek[p.id].actual == null) {
      const e = entries.get(String(p.espnId)) || entries.get(normName(p.name));
      if (e && Number.isFinite(e.actual)) {
        forWeek[p.id] = { ...forWeek[p.id], actual: e.actual, gradedAt: Date.now() };
        graded++;
      }
    }
  }

  return { calibration: { ...prev, [wk]: forWeek }, captured, graded };
}

/**
 * What the ledger holds so far. Deliberately reports coverage only — the
 * scoring analysis needs a season of data before it says anything real, and
 * publishing a verdict off three games would be exactly the overconfidence
 * this ledger exists to correct.
 */
export function calibrationStats(state) {
  const cal = state.calibration || {};
  let tracked = 0;
  let gradedRows = 0;
  const weeks = [];
  for (const [wk, rows] of Object.entries(cal)) {
    const vals = Object.values(rows || {});
    const g = vals.filter((r) => Number.isFinite(r.actual)).length;
    tracked += vals.length;
    gradedRows += g;
    if (vals.length) weeks.push({ week: Number(wk), tracked: vals.length, graded: g });
  }
  weeks.sort((a, b) => a.week - b.week);
  return { tracked, graded: gradedRows, weeks };
}

/**
 * Blend weights, EARNED rather than assumed.
 *
 * Until the ledger holds enough rows where both sources projected the same
 * player and we know what he actually scored, this returns the equal-weight
 * prior with basis "assumed". Past the threshold it weights each source by
 * the inverse of its mean absolute error — a real inverse-error weighting,
 * computed from this league's scoring and this roster's players, and labelled
 * "measured" so the UI can stop calling it an assumption.
 *
 * @param {number} minRows both-source graded rows required before refitting
 */
export function projWeights(state, minRows = 60) {
  const pairs = [];
  for (const wkRows of Object.values(state.calibration || {})) {
    for (const r of Object.values(wkRows || {})) {
      const s = r.sources || {};
      if (Number.isFinite(r.actual) && Number.isFinite(s.espn) && Number.isFinite(s.fp)) {
        pairs.push({ actual: r.actual, espn: s.espn, fp: s.fp });
      }
    }
  }
  if (pairs.length < minRows) return { ...DEFAULT_PROJ_WEIGHTS, n: pairs.length, needed: minRows };

  const mae = (pick) => pairs.reduce((sum, p) => sum + Math.abs(p.actual - pick(p)), 0) / pairs.length;
  const eErr = Math.max(0.01, mae((p) => p.espn));
  const fErr = Math.max(0.01, mae((p) => p.fp));
  const eInv = 1 / eErr;
  const fInv = 1 / fErr;
  const total = eInv + fInv;
  return {
    espn: Math.round((eInv / total) * 100) / 100,
    fp: Math.round((fInv / total) * 100) / 100,
    basis: "measured",
    n: pairs.length,
    espnMae: Math.round(eErr * 100) / 100,
    fpMae: Math.round(fErr * 100) / 100,
  };
}

/**
 * Mean error and hit-rate, ONCE there's enough to mean anything.
 * Returns null below the threshold rather than a number that would be noise.
 */
export function calibrationSummary(state, minRows = 40) {
  const rows = [];
  for (const wkRows of Object.values(state.calibration || {})) {
    for (const r of Object.values(wkRows || {})) {
      if (Number.isFinite(r.actual) && Number.isFinite(r.proj)) rows.push(r);
    }
  }
  if (rows.length < minRows) return null;

  const errs = rows.map((r) => r.actual - r.proj);
  const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
  const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
  // ~80% of results should land inside the 10th-90th band if sd is honest.
  const inBand = rows.filter((r) => {
    const lo = (r.condMean ?? r.proj) - 1.28 * (r.sd || 0);
    const hi = (r.condMean ?? r.proj) + 1.28 * (r.sd || 0);
    return r.actual >= Math.max(0, lo) && r.actual <= hi;
  }).length;
  return {
    n: rows.length,
    bias: Math.round(bias * 100) / 100,
    mae: Math.round(mae * 100) / 100,
    bandHitRate: Math.round((inBand / rows.length) * 1000) / 10,
    bandTarget: 80,
  };
}
