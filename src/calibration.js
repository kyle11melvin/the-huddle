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
//
// ---------------------------------------------------------------------------
// DO NOT MERGE THIS WITH lineup.js callCalibration. They look similar and are
// opposites, and collapsing them would quietly break both.
//
//   THIS file grades the MODEL against reality.      Judge = actual results.
//   callCalibration grades the USER against the model. Judge = the model.
//
// That split is load-bearing. Grading start/sit calls on process — did the
// decision raise win probability at the time it was made — is only defensible
// because something ELSE is independently checking whether the model deserves
// to be the judge. If the model both advises the decisions and scores them,
// with nothing auditing it against actual outcomes, the loop is circular: it
// can never be shown to be wrong, and a biased model would certify its own
// advice indefinitely.
//
// So: the ledger must never take the model's own numbers as its yardstick,
// and callCalibration must never be "simplified" into reading from here.
// Two systems, two different judges, on purpose.
// ============================================================================

import {
  pointDistribution,
  playerAnalytics,
  fpProjFor,
  propsFor,
  propsProjection,
  DEFAULT_PROJ_WEIGHTS,
} from "./analytics.js";
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
    return {
      calibration: state.calibration || {},
      captured: 0,
      graded: 0,
      missed: 0,
    };
  }

  const prev = state.calibration || {};
  const forWeek = { ...(prev[wk] || {}) };
  const entries = myEntries(state);
  let captured = 0;
  let graded = 0;
  // Players whose game had already started before any projection was captured
  // for them this week — ungradeable, and worth counting so a thin week is
  // visibly thin rather than quietly short.
  let missed = 0;

  for (const p of Object.values(state.players || {})) {
    const existing = forWeek[p.id];
    const gs = gameStateFor(state, p.team);
    const started = gs === "in" || gs === "post";

    // ---- projection side ----
    if (!existing || !existing.locked) {
      // The freeze only means anything if a PREGAME number was taken.
      //
      // Locking used to happen by recomputing the projection on the first sync
      // at or after kickoff and stamping locked:true on the result. That works
      // only when an earlier sync already ran: if nobody opened the app until
      // Sunday afternoon, the first capture of the week was a post-kickoff
      // projection wearing a pregame label, and the model got graded against a
      // number it had revised with the game in front of it. Exactly the
      // hindsight this ledger exists to rule out.
      if (started) {
        if (existing) {
          // Lock what we already had, AS IT STANDS. Never recompute here.
          forWeek[p.id] = {
            ...existing,
            locked: true,
            lockedAt: existing.lockedAt || Date.now(),
          };
          captured++;
        } else {
          // No pregame number was ever taken, so there is nothing honest to
          // grade. Record nothing and count it, rather than inventing a row.
          // The result side below finds no row for him and records no actual,
          // which is the correct outcome: an actual with no projection to
          // grade it against is not a data point.
          missed++;
        }
      } else {
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
              // A partial line set (TD-only midweek) is not a props
              // projection; grading it would blame the market for our gap.
              props: propsProjection(a, p.pos, state)?.pts ?? null,
            },
            stars: Number.isFinite(a.matchupStars) ? a.matchupStars : null,
            status: p.status || "",
            // Still open: this branch only runs before kickoff now.
            locked: false,
            lockedAt: null,
          };
          captured++;
        }
      }
    }

    // ---- result side ----
    if (gs === "post" && forWeek[p.id] && forWeek[p.id].actual == null) {
      const e = entries.get(String(p.espnId)) || entries.get(normName(p.name));
      if (e && Number.isFinite(e.actual)) {
        forWeek[p.id] = {
          ...forWeek[p.id],
          actual: e.actual,
          gradedAt: Date.now(),
        };
        graded++;
      }
    }
  }

  // ---- the rest of the league ----
  //
  // My roster is sixteen rows a week. A season of that is ~250, and only the
  // rows where every source projected the same player count toward the source
  // comparisons — so the ledger could spend the whole season never crossing its
  // own thresholds while the answer sat in the snapshot it already had.
  //
  // Every league team's roster comes down in the same sync, with ESPN's
  // projection and the actual on each entry, and both other sources are
  // reachable BY NAME: /api/odds sweeps the whole slate, and the pasted
  // FantasyPros index is keyed the same way. No extra call, no extra credit.
  //
  // What these rows DO NOT have is a distribution of our own — pointDistribution
  // needs a roster player. So they carry `sources` and `actual` and no `proj`,
  // which is exactly what the source comparisons read and exactly what
  // calibrationSummary's `Number.isFinite(r.proj)` guard keeps out of the
  // bias/band statistics, where a row with no sd would count as a miss and
  // quietly wreck the number.
  //
  // Starters only. Benches would roughly double the storage for the noisiest
  // rows on the board — backups who take a knee — and ~100 starters a week
  // already clears both thresholds in week one.
  const mine = new Set(Object.values(state.players || {}).map((p) => String(p.espnId)));
  for (const t of (state.espn && state.espn.teams) || []) {
    for (const e of t.roster || []) {
      if (!e.espnId || mine.has(String(e.espnId))) continue;
      if (!e.slot || e.slot === "BE" || e.slot === "IR") continue;
      // Namespaced: an ESPN id must never land on one of my own player ids.
      const key = `x${e.espnId}`;
      const existing = forWeek[key];
      const gs = gameStateFor(state, e.team);
      const started = gs === "in" || gs === "post";

      if (!existing || !existing.locked) {
        // The same freeze rule, for the same reason — capturing ten times as
        // many rows after kickoff would be ten times the hindsight.
        if (started) {
          if (existing) {
            forWeek[key] = { ...existing, locked: true, lockedAt: existing.lockedAt || Date.now() };
            captured++;
          } else {
            missed++;
          }
        } else {
          const fp = fpProjFor(state, wk, e.name);
          const pr = propsFor(state, wk, e.name);
          forWeek[key] = {
            ...(existing || {}),
            name: e.name,
            pos: e.pos,
            team: e.team,
            // Not my roster, so no distribution of ours — see above.
            scope: "league",
            sources: {
              espn: Number.isFinite(e.proj) ? e.proj : null,
              espnBasis: e.projBasis || null,
              fp: fp ? fp.proj : null,
              props: pr
                ? propsProjection({ propsProj: pr.proj, props: pr.props, fpInts: fp ? fp.ints : null }, e.pos, state)?.pts ?? null
                : null,
            },
            // ESPN's raw designation, stored as-is and never rendered: this is
            // the string whose first letter became an "A" badge on every
            // healthy player once already.
            injury: e.injuryStatus || "",
            locked: false,
            lockedAt: null,
          };
          captured++;
        }
      }

      if (gs === "post" && forWeek[key] && forWeek[key].actual == null && Number.isFinite(e.actual)) {
        forWeek[key] = { ...forWeek[key], actual: e.actual, gradedAt: Date.now() };
        graded++;
      }
    }
  }

  return { calibration: { ...prev, [wk]: forWeek }, captured, graded, missed };
}

/**
 * Is the props-first precedence earning its place?
 *
 * analytics.js does not BLEND props with the expert sources — when a props
 * number exists it REPLACES the ESPN/FantasyPros blend outright, on the stated
 * reasoning that "money-backed lines still outrank opinion". That is the one
 * assumption in the projection path that the ledger was recording the data for
 * and never actually checked: `sources.props` has been stored since week 1 and
 * nothing ever read it back.
 *
 * So this is a PAIRED comparison, only on rows where all three sources existed
 * and the game has been graded. Comparing props' error on the games it covers
 * against the blend's error on a different set of games would measure which
 * games are easier to project, not which source is better.
 *
 * Reported, never applied: flipping the precedence is a model change and
 * Kyle's call. One caveat to read it with — the blend weights were fit on a
 * superset of these same rows, so the blend is mildly flattered here.
 */
export function sourceAccuracy(state, minRows = 20) {
  const w = state.projWeights || DEFAULT_PROJ_WEIGHTS;
  const rows = [];
  for (const wkRows of Object.values(state.calibration || {})) {
    for (const r of Object.values(wkRows || {})) {
      const src = r.sources || {};
      if (!Number.isFinite(r.actual)) continue;
      if (!Number.isFinite(src.props) || !Number.isFinite(src.espn) || !Number.isFinite(src.fp)) continue;
      rows.push({
        actual: r.actual,
        props: src.props,
        blend: src.espn * w.espn + src.fp * w.fp,
        espn: src.espn,
        fp: src.fp,
      });
    }
  }
  if (rows.length < minRows) return { n: rows.length, needed: minRows, basis: "thin" };

  const mae = (pick) =>
    Math.round((rows.reduce((sum, r) => sum + Math.abs(r.actual - pick(r)), 0) / rows.length) * 100) / 100;
  const props = mae((r) => r.props);
  const blend = mae((r) => r.blend);
  return {
    n: rows.length,
    basis: "measured",
    props,
    blend,
    espn: mae((r) => r.espn),
    fp: mae((r) => r.fp),
    // A tenth of a point apart is not a finding, it is noise wearing a verdict.
    lead: Math.abs(props - blend) < 0.1 ? "tie" : props < blend ? "props" : "blend",
  };
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
  // Split out, because the two are not the same evidence. My rows carry a full
  // distribution and grade the whole model; league rows carry the raw sources
  // and grade only those. Reporting one number would let ~100 league rows a
  // week read as though the model itself had been checked a hundred times.
  let mine = 0;
  let league = 0;
  const weeks = [];
  for (const [wk, rows] of Object.entries(cal)) {
    const vals = Object.values(rows || {});
    const g = vals.filter((r) => Number.isFinite(r.actual)).length;
    tracked += vals.length;
    gradedRows += g;
    for (const r of vals) (r.scope === "league" ? league++ : mine++);
    if (vals.length)
      weeks.push({ week: Number(wk), tracked: vals.length, graded: g });
  }
  weeks.sort((a, b) => a.week - b.week);
  return { tracked, graded: gradedRows, mine, league, weeks };
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
      if (
        Number.isFinite(r.actual) &&
        Number.isFinite(s.espn) &&
        Number.isFinite(s.fp)
      ) {
        pairs.push({ actual: r.actual, espn: s.espn, fp: s.fp });
      }
    }
  }
  if (pairs.length < minRows)
    return { ...DEFAULT_PROJ_WEIGHTS, n: pairs.length, needed: minRows };

  const mae = (pick) =>
    pairs.reduce((sum, p) => sum + Math.abs(p.actual - pick(p)), 0) /
    pairs.length;
  const eErr = Math.max(
    0.01,
    mae((p) => p.espn),
  );
  const fErr = Math.max(
    0.01,
    mae((p) => p.fp),
  );
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
