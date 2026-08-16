// ============================================================================
// Vegas props → fantasy points.
//
// The thesis (Kyle's, and it's correct): prop lines are the only projections
// with money behind them. A book that misprices a receiving line gets picked
// apart by professionals within hours; an "expert" who's wrong loses nothing.
// So where a prop exists, it OUTRANKS every expert projection — a priority
// order, not a blend. Experts only fill the gaps books don't post lines for.
//
// Full-PPR conversion is almost pure arithmetic:
//   receptions O/U 6      → 6.0 pts
//   receiving yds O/U 69.5 → 6.95 pts
//   anytime-TD +120        → implied 45% → de-vig → E[TDs] → pts
//
// The one modelling step: "anytime TD" is P(at least one). Under a Poisson
// assumption, E[TDs] = -ln(1 - p) — a 45% anytime chance is ~0.6 expected
// TDs, not 0.45. Skipping that would systematically undercount goal-line guys.
// ============================================================================

import { matchPlayer } from "./importer.js";

// Full PPR scoring (league-confirmed)
export const SCORING = {
  reception: 1,
  recYd: 0.1,
  rushYd: 0.1,
  passYd: 0.04,
  passTd: 4,
  int: -2,
  rushRecTd: 6,
};

/** American odds → implied probability (vig still in). */
export function impliedProb(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

/**
 * Strip the book's cut. With both sides of a market you'd normalise; with a
 * single anytime-TD price the standard approximation is scaling by ~0.955
 * per side of juice — imperfect, but far better than running every
 * projection hot.
 */
export const deVig = (p) => (p == null ? null : Math.max(0, Math.min(0.97, p * 0.955)));

/** P(at least one TD) → expected TD count, Poisson-inverted. */
export const expectedTds = (p) => (p == null || p <= 0 ? 0 : -Math.log(1 - Math.min(p, 0.97)));

/**
 * Convert one player's prop lines to projected PPR points.
 * Any subset of markets works; missing markets contribute nothing.
 * @returns {{points:number, parts:Array<[string, number]>}}
 */
export function propsToPoints(props) {
  const parts = [];
  const add = (label, pts) => {
    if (Number.isFinite(pts) && Math.abs(pts) > 0.001) parts.push([label, Math.round(pts * 100) / 100]);
  };

  add(`${props.receptions ?? 0} rec`, (props.receptions || 0) * SCORING.reception);
  add(`${props.recYds ?? 0} rec yds`, (props.recYds || 0) * SCORING.recYd);
  add(`${props.rushYds ?? 0} rush yds`, (props.rushYds || 0) * SCORING.rushYd);
  add(`${props.passYds ?? 0} pass yds`, (props.passYds || 0) * SCORING.passYd);
  add(`${props.passTds ?? 0} pass TD`, (props.passTds || 0) * SCORING.passTd);
  add(`${props.ints ?? 0} INT`, (props.ints || 0) * SCORING.int);

  if (props.anytimeTdOdds != null) {
    const p = deVig(impliedProb(props.anytimeTdOdds));
    const eTds = expectedTds(p);
    add(`TD ${props.anytimeTdOdds > 0 ? "+" : ""}${props.anytimeTdOdds} (${Math.round((p || 0) * 100)}%)`, eTds * SCORING.rushRecTd);
  } else if (Number.isFinite(props.tds)) {
    // some books post an O/U on total TDs directly
    add(`${props.tds} TDs`, props.tds * SCORING.rushRecTd);
  }

  const points = parts.reduce((n, [, v]) => n + v, 0);
  return { points: Math.round(points * 10) / 10, parts };
}

// ------------------------------------------------------------------ parser ---

// market patterns → prop key. Ordered: more specific first.
const MARKETS = [
  [/rec(?:eiving)?\s*(?:yards|yds)/i, "recYds"],
  [/rush(?:ing)?\s*(?:yards|yds)/i, "rushYds"],
  [/pass(?:ing)?\s*(?:yards|yds)/i, "passYds"],
  [/pass(?:ing)?\s*(?:touchdowns|tds?)/i, "passTds"],
  [/interceptions?|ints?\b/i, "ints"],
  [/receptions?|catches\b/i, "receptions"],
  [/total\s*(?:touchdowns|tds?)/i, "tds"],
];

const ANYTIME_RE = /any\s*time|anytime|to\s+score\s+a?\s*(?:td|touchdown)/i;
const NUM_RE = /(\d{1,3}(?:\.\d)?)/;
const ODDS_RE = /([+\-−–]\d{3,4})\b/;

/**
 * Parse pasted sportsbook / props text. Format-agnostic by design: it walks
 * line by line, treats any line matching one of your rostered players as the
 * start of that player's block, and scans subsequent lines for markets.
 *
 * @returns {{players: Array<{player, props, computed}>, unmatchedLines:number}}
 */
export function parseProps(text, rosterPlayers) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.replace(/ /g, " ").trim());
  const blocks = [];
  let current = null;
  let unmatchedLines = 0;

  const readMarket = (line, target) => {
    let hit = false;
    if (ANYTIME_RE.test(line)) {
      const odds = ODDS_RE.exec(line.replace(/[−–]/g, "-"));
      if (odds) {
        target.anytimeTdOdds = parseInt(odds[1].replace(/[−–]/g, "-"), 10);
        hit = true;
      }
    }
    // A line can carry several markets ("rec yds 58.5 | receptions 4.5"),
    // so every pattern gets a chance — each reads the number after its own label.
    for (const [re, key] of MARKETS) {
      if (!re.test(line) || target[key] != null) continue;
      const after = line.slice(line.search(re));
      const m = NUM_RE.exec(after) || NUM_RE.exec(line);
      if (m) {
        target[key] = parseFloat(m[1]);
        hit = true;
      }
    }
    return hit;
  };

  // A name can arrive alone ("Tee Higgins") or with a market glued on
  // ("Chase Brown rush yds 72.5"), so failing a whole-line match we retry the
  // first few words — a name is almost always the line's leading 2-3 tokens.
  const findName = (line) => {
    const cleaned = line.replace(/\b(O\/U|over|under|props?|odds)\b.*$/i, "");
    let { match } = matchPlayer(cleaned, rosterPlayers);
    if (match) return match;
    const words = cleaned.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    for (const n of [3, 2]) {
      if (words.length <= n) continue;
      ({ match } = matchPlayer(words.slice(0, n).join(" "), rosterPlayers));
      if (match) return match;
    }
    return null;
  };

  for (const line of lines) {
    if (!line) continue;
    const match = findName(line);
    if (match) {
      current = { player: match, props: {} };
      blocks.push(current);
      // markets can share the player's line ("Tee Higgins rec yds 69.5")
      readMarket(line, current.props);
      continue;
    }
    if (current) {
      if (!readMarket(line, current.props)) unmatchedLines++;
    } else {
      unmatchedLines++;
    }
  }

  // de-dupe: keep the last block per player (later paste wins)
  const byId = new Map();
  for (const b of blocks) byId.set(b.player.id, b);
  const players = [...byId.values()]
    .filter((b) => Object.keys(b.props).length > 0)
    .map((b) => ({ ...b, computed: propsToPoints(b.props) }));

  return { players, unmatchedLines };
}
