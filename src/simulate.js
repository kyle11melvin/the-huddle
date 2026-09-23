// ============================================================================
// Monte Carlo matchup simulation.
//
// The whole reason this exists: fantasy sites tell you which player scores more
// points. That is a statement about the player, identical for everyone who owns
// him. Whether YOU should start the volatile guy depends on whether you're
// favoured or an underdog this week — chasing variance when you're behind and
// floor when you're ahead is the actual correct play, and it needs your matchup.
//
// Output is a win probability, so lineup decisions get compared on the thing
// that decides your season instead of on projected points.
//
// Players are NOT independent draws. A QB and his receivers rise and fall
// together (the stack), everyone in one NFL game shares its script, and a
// D/ST eats when the opposing offense starves. The sim models this with a
// factor structure (Gaussian copula over lognormal marginals): each NFL game
// and each offense gets a latent factor, players load onto them by position,
// and the leftover variance is player-specific. Marginals are unchanged —
// correlation only reshapes the JOINT outcomes, which is exactly what win
// probability cares about.
// ============================================================================

import { SLOT_DEFS, findLocation, slotAccepts, bestLineupFrom } from "./lineup.js";
import { pointDistribution, blendProjection, fpProjFor, propsFor } from "./analytics.js";
import { LEAGUE_ROSTERS } from "./data/leagueRosters.js";
import { espnTeamRoster, liveEntryFor } from "./espnSync.js";
import { scheduleOpp } from "./scheduleSync.js";
import { kickoffLabel } from "./headToHead.js";

const RUNS = 20000;

/** Deterministic PRNG so the same inputs don't produce a jittering percentage. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, reused across a pair of draws. */
function makeNormal(rand) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

// ------------------------------------------------------------- correlation ---

// Factor loadings by position. Chosen to land on the empirically reported
// ranges: QB↔his WR/TE ≈ +0.3, QB↔his RB ≈ +0.15, same-game opponents mildly
// positive (shootouts lift everyone), D/ST vs opposing offense ≈ −0.25.
// Directional like BASE_CV — refit from real game logs once the season runs.
const TEAM_LOAD = { QB: 0.55, WR: 0.5, TE: 0.5, RB: 0.22, K: 0.3 };
const DST_OPP_LOAD = -0.45; // D/ST rides the OPPOSING offense factor, inverted
const GAME_LOAD = 0.2;
const DST_GAME_LOAD = -0.15; // shootouts are bad for defenses

const cleanAbbr = (s) => {
  const a = (s || "").replace(/^@/, "").trim().toUpperCase();
  return a && a !== "BYE" ? a : null;
};

/**
 * Build a per-iteration generator of correlated standard normals for a set of
 * players (my side AND the opponent's, together — my WR and their D/ST can
 * share an NFL game). Players without team/opp info degrade gracefully to
 * independent draws.
 */
function correlatedNormals(dists, normal) {
  const meta = dists.map((d) => {
    const team = cleanAbbr(d.team);
    const opp = cleanAbbr(d.opp);
    const pos = d.pos || "";
    let wTeam = 0;
    let teamKey = null;
    if (pos === "D/ST") {
      if (opp) {
        wTeam = DST_OPP_LOAD;
        teamKey = opp;
      }
    } else if (team && TEAM_LOAD[pos]) {
      wTeam = TEAM_LOAD[pos];
      teamKey = team;
    }
    const gameKey = team && opp ? [team, opp].sort().join("|") : null;
    const wGame = gameKey ? (pos === "D/ST" ? DST_GAME_LOAD : GAME_LOAD) : 0;
    const wIdio = Math.sqrt(Math.max(0, 1 - wTeam * wTeam - wGame * wGame));
    return { wTeam, teamKey, wGame, gameKey, wIdio };
  });
  const teamKeys = [...new Set(meta.map((m) => m.teamKey).filter(Boolean))];
  const gameKeys = [...new Set(meta.map((m) => m.gameKey).filter(Boolean))];
  return () => {
    const t = {};
    for (const k of teamKeys) t[k] = normal();
    const g = {};
    for (const k of gameKeys) g[k] = normal();
    return meta.map(
      (m) =>
        m.wTeam * (m.teamKey ? t[m.teamKey] : 0) +
        m.wGame * (m.gameKey ? g[m.gameKey] : 0) +
        m.wIdio * normal()
    );
  };
}

/**
 * Fantasy scores are right-skewed and never negative → lognormal marginals
 * matched to the conditional mean/sd, fed by a correlated z. Injury risk is
 * bimodal: with prob playProb the player produces the distribution, otherwise
 * exactly zero (a Questionable tag is not a 23% haircut, it's a 23% chance of
 * a donut).
 */
function lognormTransform(d, rand) {
  const mean = d.condMean ?? d.mean;
  const playProb = d.playProb ?? 1;
  if (!(mean > 0) || playProb <= 0) return () => 0;
  const sd = d.sd || 0;
  const variance = Math.max(sd * sd, 1e-6);
  const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)));
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  if (playProb >= 1) return (z) => Math.exp(mu + sigma * z);
  return (z) => (rand() < playProb ? Math.exp(mu + sigma * z) : 0);
}

// ---------------------------------------------------------------- lineups ---

/** Opponent NFL team for a player this week, from the synced schedule. */
const nflOppOf = (state, team, week) => cleanAbbr(scheduleOpp(state, team, week));

/** Distributions for every player in a starting lineup. */
export function lineupDistributions(state, lineup, week) {
  const out = [];
  const missing = [];
  for (const s of SLOT_DEFS) {
    for (const id of lineup[s.key] || []) {
      if (!id) continue;
      const p = state.players[id];
      if (!p) continue;
      const d = pointDistribution(p, week, state);
      if (d) out.push({ id, name: p.name, team: p.team || null, pos: p.pos, opp: nflOppOf(state, p.team, week), ...d });
      else missing.push(p.name);
    }
  }
  return { dists: out, missing };
}

/** Sum of EXPECTED points (injury-priced means). */
export const sumMeans = (dists) => Math.round(dists.reduce((n, d) => n + d.mean, 0) * 10) / 10;

// ESPN's raw injury strings → play probability, for opponent rosters.
const OPP_PLAY_PROB = { QUESTIONABLE: 0.77, DOUBTFUL: 0.25, OUT: 0, INJURY_RESERVE: 0, SUSPENSION: 0 };
const CVS = { QB: 0.32, RB: 0.5, WR: 0.58, TE: 0.6, K: 0.42, "D/ST": 0.72 };

/**
 * Position rank → expected fantasy points. A rough curve, but the ONLY one in
 * the app: everything that has to price a player from a rank alone uses this,
 * so a rank-derived estimate and a real projection are always the same kind
 * of number and can be compared directly.
 */
export const rankToPoints = (rank) =>
  Math.max(4, 22 - Math.log2(Math.max(1, rank)) * 3.1);

/**
 * The opponent side of any simulation, one canonical builder (Lab, optimizer
 * and Gameday all use this instead of three hand-rolled copies).
 * Live ESPN starters + projections when synced; static-roster rank estimates
 * as the offline fallback.
 */
/**
 * Stable identity for an opponent roster entry.
 *
 * espnId FIRST: the normalized name strips every non-letter, so two players
 * whose names differ only by a digit or suffix collapse to the same key —
 * and bestLineupFrom would then treat them as one player and silently drop
 * the other from the lineup. Same duplicate-identity class as finding 12e.
 */
const oppKey = (e) =>
  (e && e.espnId ? `id:${e.espnId}` : `nm:${(e && e.name ? e.name : "").toLowerCase().replace(/[^a-z]/g, "")}`);

/**
 * One opponent roster entry → a distribution, injury-priced.
 *
 * Priced through blendProjection — the SAME ladder Kyle's own roster gets —
 * rather than raw `e.proj`. The card used to say it out loud: "Opponent
 * player — ESPN projection. Props, matchup and consensus are computed for
 * your roster only." Two sides of one matchup, two different models, and the
 * win probability was the difference between them.
 *
 * The pasted expert number is fetched BY NAME, because an opponent starter
 * has no roster id to look an analytics record up with. Where no paste
 * mentions him the blend degrades to exactly ESPN's number, so nobody is
 * quietly repriced.
 */
export const opponentDist = (state, week, e) => {
  const playProb = OPP_PLAY_PROB[e.injuryStatus] ?? 1;
  const fp = fpProjFor(state, week, e.name);
  const book = propsFor(state, week, e.name);
  // The SAME record shape pointDistribution builds for my own players, so the
  // same ladder runs: props first, then the ESPN+FP blend, then ESPN alone.
  const blend = blendProjection(
    { proj: e.proj, fpProj: fp ? fp.proj : null, propsProj: book ? book.proj : null, props: book ? book.props : null, fpInts: fp ? fp.ints : null, fpFumbles: fp ? fp.fumbles : null, fpTwoPt: fp ? fp.twoPt : null },
    e.pos,
    e.team,
    state
  );
  // blendProjection returns null only when there is no number at all; the
  // callers above already filter on a finite e.proj, so this is belt-and-
  // braces rather than a live path.
  const mu = blend ? blend.mu : e.proj;
  const sd = blend ? blend.sd : e.proj * (CVS[e.pos] ?? 0.55);
  return {
    id: oppKey(e),
    name: e.name,
    team: e.team || null,
    pos: e.pos,
    opp: nflOppOf(state, e.team, week),
    mean: Math.round(mu * playProb * 10) / 10,
    condMean: Math.round(mu * 10) / 10,
    sd: Math.round(sd * 10) / 10,
    playProb,
    slot: e.slot,
    injuryStatus: e.injuryStatus,
    source: blend ? blend.source : "projection",
  };
};

/**
 * BOTH opponent lineups: the one they have set, and the one they'd most
 * likely start if they tidied up before kickoff.
 *
 * Why both rather than a single blended number: "58% against their likely
 * lineup, 71% against what they have set" tells you they might fix it — which
 * is actionable. A blend hides that entirely.
 *
 * A player whose game has already kicked off CANNOT be moved, so those slots
 * are pinned to reality and only the still-unlocked slots get optimized. That
 * makes the two lineups converge naturally as Sunday progresses.
 *
 * @returns {{actual, likely, differs, changes, anyLocked}|null}
 */
export function opponentLineups(state, week, oppTeamOverride) {
  const oppTeam = oppTeamOverride || (state.matchups && state.matchups[week] && state.matchups[week].oppTeam) || "";
  if (!oppTeam) return null;
  const live = espnTeamRoster(state, oppTeam);
  if (!live) return null;

  const usable = live.filter((e) => e.slot !== "IR" && Number.isFinite(e.proj) && e.proj > 0);
  const actualStarters = usable.filter((e) => e.slot !== "BE");
  const actual = actualStarters.map((e) => opponentDist(state, week, e));

  // Pin every started player to the slot they're actually in — locked by
  // kickoff, not a choice their manager still has.
  const games = (state.espn && state.espn.games) || {};
  const isLocked = (e) => {
    const g = games[e.team];
    return !!g && (g.state === "in" || g.state === "post");
  };
  const pinned = {};
  const cursor = {};
  for (const e of actualStarters) {
    if (!isLocked(e)) continue;
    const key = e.slot;
    cursor[key] = cursor[key] || 0;
    pinned[`${key}:${cursor[key]++}`] = oppKey(e);
  }

  const byId = new Map(usable.map((e) => [oppKey(e), e]));
  const candidates = usable.map((e) => {
    const d = opponentDist(state, week, e);
    return { id: d.id, pos: e.pos, score: d.mean };
  });
  const { starterIds } = bestLineupFrom(candidates, pinned);
  const likely = [...starterIds].map((id) => opponentDist(state, week, byId.get(id))).filter(Boolean);

  const actualIds = new Set(actual.map((d) => d.id));
  const benched = actual.filter((d) => !starterIds.has(d.id));
  const promoted = likely.filter((d) => !actualIds.has(d.id));
  return {
    actual,
    likely,
    differs: benched.length > 0 || promoted.length > 0,
    changes: benched.map((out, i) => ({ out, in: promoted[i] || null })),
    anyLocked: Object.keys(pinned).length > 0,
    oppTeam,
  };
}

export function opponentDistributions(state, week, oppTeamOverride, mode = "likely") {
  const oppTeam = oppTeamOverride || (state.matchups && state.matchups[week] && state.matchups[week].oppTeam) || "";
  if (!oppTeam) return [];

  const live = espnTeamRoster(state, oppTeam);
  if (live) {
    const both = opponentLineups(state, week, oppTeam);
    if (both) return mode === "actual" ? both.actual : both.likely;
    return [];
  }

  const oppRoster = LEAGUE_ROSTERS.find((t) => t.team === oppTeam);
  if (!oppRoster) return [];
  const out = [];
  for (const [name, team, pos] of oppRoster.starters) {
    const k = name.toLowerCase().replace(/[^a-z]/g, "");
    const rank = state.ecrIndex ? state.ecrIndex[k] : null;
    if (rank == null) continue;
    // Rough points-from-rank curve, only used to give the simulation an
    // opponent at all. NOT injury-priced — unlike opponentDist() on the live path,
    // nothing here knows a player is out, so a ruled-out starter is valued at
    // his healthy rank. `estimated` marks every entry so a consumer cannot
    // present these as real projections by accident.
    const mean = rankToPoints(rank);
    out.push({
      id: k,
      name,
      team: team || null,
      pos,
      opp: nflOppOf(state, team, week),
      mean,
      sd: mean * (CVS[pos] ?? 0.55),
      estimated: true,
    });
  }
  return out;
}

/**
 * Which path opponentDistributions() ACTUALLY took: "live" | "estimated" | "none".
 *
 * The UI used to infer this from `state.espn` being truthy, which is a
 * different question and gets it wrong in the case that matters. `state.espn`
 * is a persisted blob from the last successful sync, so it stays truthy long
 * after ESPN stops answering — cookies expire roughly annually and this league
 * has been running since August. The result was a screen that said "Both sides
 * use real ESPN projections" while quietly running rank estimates.
 *
 * That is the same failure shape as a roster that looked current but wasn't,
 * and a badge reading SYNCED on a device that was syncing nothing: plausible
 * numbers, no indication anything had degraded. Ask the question directly.
 */
export function opponentSource(state, week, oppTeamOverride) {
  const oppTeam =
    oppTeamOverride || (state.matchups && state.matchups[week] && state.matchups[week].oppTeam) || "";
  if (!oppTeam) return "none";
  if (espnTeamRoster(state, oppTeam)) return "live";
  const oppRoster = LEAGUE_ROSTERS.find((t) => t.team === oppTeam);
  return oppRoster ? "estimated" : "none";
}

/**
 * Age of the ESPN snapshot in ms, or null if there has never been one.
 *
 * Separate from opponentSource because they fail differently: a sync that
 * stops working leaves the LAST roster in place, so the live path keeps being
 * taken with data that is hours or days old. Nothing falls back, nothing
 * errors, the numbers just quietly stop moving.
 */
export function espnAgeMs(state, now = Date.now()) {
  const at = state && state.espn && state.espn.fetchedAt;
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/**
 * Staleness thresholds. Conditional, because "too old" means something
 * completely different at 1pm on a Sunday than it does on a Tuesday.
 *
 * WHILE MY PLAYERS ARE ON THE FIELD: 10 minutes. Gameday polls ESPN every 2
 * minutes whenever a game is live (Gameday.jsx), so 10 is five missed polls —
 * comfortably outside healthy operation, and a tight bound costs nothing when
 * the normal refresh is 5x faster. A 3-hour threshold here would stay silent
 * through the entire early window while the screen showed pregame numbers,
 * which is precisely the failure the banner exists to catch.
 *
 * OTHERWISE: 3 hours. Nothing is moving, the poll isn't running, and warning
 * about a two-hour-old sync on a Wednesday is noise that teaches you to ignore
 * the banner — which would cost more than it saves.
 */
export const STALE_LIVE_MS = 10 * 60 * 1000;
export const STALE_IDLE_MS = 3 * 60 * 60 * 1000;

/**
 * Does the user have a player whose NFL game is in progress right now?
 *
 * Deliberately scoped to teams on THIS roster rather than the league-wide
 * anyGameLive(): if none of my players are on the field, frozen data is not
 * urgent. It is a strict subset of the condition that drives the 2-minute
 * poll, so a tight threshold can never fire while that poll is healthy.
 */
export function myGameLive(state) {
  const games = state && state.espn && state.espn.games;
  if (!games) return false;
  for (const p of Object.values((state && state.players) || {})) {
    const g = p && p.team ? games[p.team] : null;
    if (g && g.state === "in") return true;
  }
  return false;
}

/** The staleness bound that applies to this state right now. */
export function staleAfterMs(state) {
  return myGameLive(state) ? STALE_LIVE_MS : STALE_IDLE_MS;
}

/**
 * "12m" / "4h" / "2d" — the age, at whatever scale reads naturally.
 *
 * The live threshold is 10 minutes, so an hours-only formatter renders the
 * warning that matters most as "0h ago" and destroys its own credibility.
 */
export function agoLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// -------------------------------------------------------------- simulation ---

/**
 * @returns {{winProb, myMean, oppMean, myP10, myP90, margin}|null}
 */
export function simulateMatchup(myDists, oppDists, seed = 12345, runs = RUNS) {
  if (!myDists.length || !oppDists.length) return null;
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);

  // One factor context across BOTH lineups — my WR and their D/ST can be in
  // the same NFL game, and that anti-correlation is real win-prob signal.
  const all = [...myDists, ...oppDists];
  const zGen = correlatedNormals(all, normal);
  const fns = all.map((d) => lognormTransform(d, rand));
  const nMine = myDists.length;

  let wins = 0;
  const totals = new Array(runs);
  let marginSum = 0;
  for (let i = 0; i < runs; i++) {
    const z = zGen();
    let a = 0;
    for (let j = 0; j < nMine; j++) a += fns[j](z[j]);
    let b = 0;
    for (let j = nMine; j < all.length; j++) b += fns[j](z[j]);
    totals[i] = a;
    marginSum += a - b;
    if (a > b) wins++;
  }
  totals.sort((x, y) => x - y);
  const pct = (q) => Math.round(totals[Math.floor(q * (runs - 1))] * 10) / 10;

  return {
    winProb: wins / runs,
    myMean: sumMeans(myDists),
    oppMean: sumMeans(oppDists),
    myP10: pct(0.1),
    myP90: pct(0.9),
    margin: Math.round((marginSum / runs) * 10) / 10,
  };
}

/**
 * Distributions -> live simulation entries.
 *
 * The bridge that was missing. `lineupDistributions` and `opponentDistributions`
 * both produce PREGAME distributions, and the Lab fed them straight to
 * `simulateMatchup`, which has no concept of a game having been played. A
 * player who had already finished still contributed a full-variance
 * distribution around a projection the game had disproved.
 *
 * Everything needed to fix that already existed — `simulateLive` prices
 * final/live/pre correctly and Gameday has used it all along. This is the
 * adapter, so there is ONE live model rather than a second copy of it.
 *
 * `condMean` is the if-he-plays number and is what `simulateLive` wants:
 * it applies playProb itself, and once a player is on the field his Q/D coin
 * flip has already resolved. Falls back to `mean` for the hand-built
 * distributions some callers pass.
 *
 * cv comes from each distribution's OWN sd rather than a shared position
 * table, so a blended or widened projection keeps the spread it earned.
 */
export function liveEntriesFrom(state, dists) {
  return (dists || []).map((d) => {
    const l = liveEntryFor(state, d.name, d.team) || {};
    const ifPlays = Number.isFinite(d.condMean) ? d.condMean : d.mean;
    return {
      proj: Number.isFinite(ifPlays) ? ifPlays : 0,
      playProb: Number.isFinite(d.playProb) ? d.playProb : 1,
      scored: Number.isFinite(l.scored) ? l.scored : 0,
      pctRemaining: Number.isFinite(l.pctRemaining) ? l.pctRemaining : 1,
      status: l.status || "notStarted",
      cv: Number.isFinite(d.sd) && ifPlays > 0 ? d.sd / ifPlays : CVS[d.pos] ?? 0.55,
      // correlation metadata: same NFL game -> shared factor
      team: d.team || null,
      pos: d.pos || null,
      opp: d.opp || null,
    };
  });
}

/**
 * The matchup as it stands RIGHT NOW, from pregame distributions.
 *
 * Before kickoff every entry is `notStarted` and this is the pregame sim with
 * extra steps — which is the point: one code path that is correct on Sunday
 * afternoon as well as Saturday night, instead of two that disagree.
 */
export function simulateMatchupLive(state, myDists, oppDists, seed = 12345) {
  if (!myDists || !oppDists || !myDists.length || !oppDists.length) return null;
  return simulateLive(liveEntriesFrom(state, myDists), liveEntriesFrom(state, oppDists), seed);
}

/**
 * Win probability if `inId` started in place of `outId`.
 * This is the number that actually answers "who should I start".
 */
export function simulateSwap(state, week, oppDists, outId, inId, seed = 12345) {
  const p = state.players[inId];
  if (!p) return null;

  // Legality BEFORE arithmetic. The optimizer's scan checks slot eligibility;
  // without the same check here the Lab would render "Start <WR> over <QB> ·
  // +2.1% win — Apply to ESPN" for a swap movePlayer then refuses. Guarding
  // inside simulateSwap means no future caller can reintroduce it.
  const loc = findLocation(state, outId);
  if (!loc || loc.zone !== "lineup") {
    return { illegal: true, reason: `${state.players[outId]?.name || "That player"} isn't in a starting slot.` };
  }
  if (!slotAccepts(loc.slotKey, p.pos)) {
    return { illegal: true, reason: `The ${loc.slotKey} slot doesn't accept a ${p.pos}.` };
  }

  const base = lineupDistributions(state, state.lineup, week);
  const swapped = base.dists.filter((d) => d.id !== outId);
  const d = pointDistribution(p, week, state);
  if (!d) return null;
  swapped.push({ id: inId, name: p.name, team: p.team || null, pos: p.pos, opp: nflOppOf(state, p.team, week), ...d });

  // Live-aware, same as the headline number this delta is compared against.
  // On the pregame sim a swap delta was measured against a matchup that could
  // already be decided, and the two numbers on screen came from different
  // models. (`runs` went with it — simulateLive uses one fixed run count.)
  const before = simulateMatchupLive(state, base.dists, oppDists, seed);
  const after = simulateMatchupLive(state, swapped, oppDists, seed);
  if (!before || !after) return null;
  return { before, after, delta: after.winProb - before.winProb };
}

// ---------------------------------------------------------------- live ------

/**
 * Live, in-progress win probability.
 *
 * The case that makes this worth building: 200 points with every player done
 * beats 180 points on paper — but if that 180 has a player left on Monday
 * night projected for 25, the 180 team is actually the favourite. Raw points
 * are meaningless without knowing who still has football left to play.
 *
 * Each player contributes:
 *   final       → exactly what they scored, no variance at all
 *   not started → their full projected distribution (× play probability if
 *                 they carry a Q/D tag)
 *   in progress → what they've banked, plus the fraction of their projection
 *                 still to come. Variance scales with sqrt(remaining) because
 *                 a player with a quarter left is far more predictable than
 *                 one at kickoff.
 *
 * Correlation applies to the UNPLAYED portions through the same factor
 * structure as the pre-game sim; banked points are facts and carry none.
 *
 * @param {Array} sides [{proj, scored, pctRemaining, status, cv, team, opp, pos, playProb}]
 */
/**
 * Fraction of a player's game still to be played, 0..1.
 *
 * Time-based today: it comes from the scoreboard clock via api/espn.js. That
 * is an approximation — a leading team kneeling and a trailing team spiking
 * burn the same clock at completely different play rates, so the same 5:00
 * remaining is worth very different numbers of snaps. Counting remaining
 * PLAYS rather than minutes is the real model; this is the honest simple
 * version until there's something to check it against.
 */
export function remainingFraction(status, pctRemaining) {
  if (status === "final") return 0;
  if (status === "inProgress") return Math.max(0, Math.min(1, pctRemaining ?? 0));
  return 1; // notStarted — the whole game is still ahead
}

/**
 * What a player's projection should READ once his game is underway.
 *
 *   live = points already scored + (if-he-plays projection × fraction left)
 *
 * Exported and shared with the row display on purpose. The Gameday rows used
 * to render a STATIC pregame number from a different source than the sim at
 * the top of the same screen, so Stafford sat at 22.2 with 1 point scored and
 * a quarter to play. One function, one number, no drift.
 *
 * `pregame` and `ifPlays` are deliberately separate inputs: before kickoff the
 * row shows the injury-priced expectation, but once a player is on the field
 * his Q/D coin flip has already resolved, so the REMAINING portion accrues at
 * the if-he-plays rate rather than the discounted one.
 *
 * @returns {number|null} points, or null when there is no projection at all
 */
export function liveProjection({ pregame, ifPlays, scored, pctRemaining, status, playProb = 1 }) {
  const banked = Number.isFinite(scored) ? scored : 0;

  // Pre-kickoff is untouched — nothing has happened yet to decay.
  if (status !== "inProgress" && status !== "final") {
    return Number.isFinite(pregame) ? pregame : null;
  }
  // A finished game has no estimate left in it: the projection IS the actual.
  if (status === "final") return banked;
  // Ruled out or on bye. Collapse to what he banked rather than decaying
  // gently toward it — a player who is not on the field will not accumulate
  // the rest of his projection at any rate, and a slow fade reads as "still
  // has a chance" when he does not.
  if (playProb === 0) return banked;

  const rate = Number.isFinite(ifPlays) ? ifPlays : Number.isFinite(pregame) ? pregame : null;
  if (rate == null) return banked;

  const live = banked + Math.max(0, rate * remainingFraction(status, pctRemaining));
  // Never below points already on the board — those are facts, and a
  // projection under them would be nonsense on its face.
  return Math.max(banked, Math.round(live * 10) / 10);
}

/**
 * The approved three-state view-model for ONE player, for any surface that
 * renders him. DESIGN.md's table is approved for anywhere a player row
 * renders, not only the paired board — but only the board had it, so the
 * roster screen went on showing a projection for a player whose game had
 * finished hours earlier.
 *
 *   FINAL  what he actually scored, with the PREGAME projection beneath it and
 *          a direction on it: did he beat what we said he would? That number
 *          is the whole grade on a finished player, and hiding it threw the
 *          week away (Kyle, Sept 21 — this reverses the earlier call).
 *   LIVE   what he has BANKED, with the projected finish beneath it, plus a
 *          direction on that projection so fading and going off do not look
 *          alike. The banked number carries no direction: it is a fact.
 *   PRE    the projection alone.
 *
 * Every state carries a WORD as well as a colour, because colour alone fails
 * a glance in sunlight and fails a colour-blind reader completely.
 *
 * `liveEntry` overrides the ESPN lookup for Gameday's manual (non-auto) mode,
 * where a human has typed the score.
 *
 * @param {{name, team}} player anything carrying a name and an NFL team
 * @param {{mean, condMean, playProb}|null} dist his pregame distribution
 */
export function rowGameState(state, player, week, dist, liveEntry) {
  const l = liveEntry || (player && liveEntryFor(state, player.name, player.team)) || {};
  const status = l.status || "notStarted";
  const isFinal = status === "final";
  const isLive = status === "inProgress";
  const scored = Number.isFinite(l.scored) ? l.scored : 0;

  const pregame = dist && Number.isFinite(dist.mean) ? dist.mean : null;
  const ifPlays = dist && Number.isFinite(dist.condMean) ? dist.condMean : pregame;
  const live = liveProjection({
    pregame,
    ifPlays,
    scored: l.scored,
    pctRemaining: l.pctRemaining,
    status,
    playProb: dist && Number.isFinite(dist.playProb) ? dist.playProb : 1,
  });

  // Live and final both lead with the fact and put a projection under it (Kyle,
  // Sept 21, against ESPN's matchup tab). The row used to lead with the decayed
  // projection and strike the pregame figure beneath, so the one number that
  // was not an estimate — what he has actually scored — was the one number not
  // on the screen you only look at while the games are on.
  const value = isFinal || isLive ? scored : live;
  // WHICH projection differs by state, and it has to: at final the live
  // projection has collapsed to the actual, so printing it would print the
  // headline twice. The pregame figure is the one that still says something —
  // "projected 11.5, got 5" is the read on a finished player.
  const sub = isFinal ? pregame : isLive ? live : null;
  // One question in both states — better or worse than we thought — carried by
  // a different number in each: live it is the estimate against pregame, at
  // final the actual against pregame.
  const judged = isFinal ? scored : sub;
  const dir =
    sub != null && pregame != null && judged != null && Math.abs(pregame - judged) >= 0.1
      ? judged > pregame
        ? "up"
        : "down"
      : "";

  const game = (state.espn && state.espn.games && player && player.team && state.espn.games[player.team]) || null;
  const when = game && game.startTime ? kickoffLabel(game.startTime) : "";

  return {
    status,
    isFinal,
    isLive,
    value,
    sub,
    dir,
    // What he is WORTH right now, which is no longer what the row displays:
    // banked points once final, the projected finish while football remains.
    // A comparison between two players has to weigh where they will finish, or
    // it hands the slot to whoever happened to kick off first.
    worth: isFinal ? scored : live,
    chip: isFinal ? "FINAL" : isLive ? l.detail || "LIVE" : when || "PRE",
    prog: isFinal ? 1 : isLive ? 1 - (l.pctRemaining ?? 1) : 0,
    when,
  };
}

function liveParts(entries, rand) {
  return entries.map((e) => {
    const scored = Number.isFinite(e.scored) ? e.scored : 0;
    if (e.status === "final") return { fixed: scored };

    const remainingFrac = remainingFraction(e.status, e.pctRemaining);
    const remainingMean = Math.max(0, (e.proj || 0) * remainingFrac);
    if (remainingMean <= 0) return { fixed: scored };

    const cv = e.cv ?? 0.55;
    // Full-game sd shrunk by sqrt of the fraction still to be played.
    const sd = (e.proj || 0) * cv * Math.sqrt(remainingFrac);
    const variance = Math.max(sd * sd, 1e-6);
    const sigma = Math.sqrt(Math.log(1 + variance / (remainingMean * remainingMean)));
    const mu = Math.log(remainingMean) - (sigma * sigma) / 2;
    // A Q/D tag only matters before kickoff — a player already on the field
    // has resolved his coin flip.
    const playProb = e.status === "notStarted" ? e.playProb ?? 1 : 1;
    return { scored, mu, sigma, playProb, rand };
  });
}

export function simulateLive(myEntries, oppEntries, seed = 991) {
  if (!myEntries.length || !oppEntries.length) return null;
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);

  const all = [...myEntries, ...oppEntries];
  const zGen = correlatedNormals(all, normal);
  const parts = liveParts(all, rand);
  const nMine = myEntries.length;

  const draw = (part, z) => {
    if (part.fixed != null) return part.fixed;
    if (part.playProb < 1 && rand() >= part.playProb) return part.scored;
    return part.scored + Math.exp(part.mu + part.sigma * z);
  };

  let wins = 0;
  let ties = 0;
  const totals = new Array(RUNS);
  const oppTotals = new Array(RUNS);
  for (let i = 0; i < RUNS; i++) {
    const z = zGen();
    let a = 0;
    for (let j = 0; j < nMine; j++) a += draw(parts[j], z[j]);
    let b = 0;
    for (let j = nMine; j < all.length; j++) b += draw(parts[j], z[j]);
    totals[i] = a;
    oppTotals[i] = b;
    if (a > b) wins++;
    else if (Math.abs(a - b) < 1e-9) ties++;
  }
  const sortedMine = [...totals].sort((x, y) => x - y);
  const sortedOpp = [...oppTotals].sort((x, y) => x - y);
  const q = (arr, p) => Math.round(arr[Math.floor(p * (RUNS - 1))] * 10) / 10;
  // Headline projection = MEAN, matching the sum of the player column (the
  // median of a right-skewed sim runs ~2% low and reads like a math error).
  const mean = (arr) => Math.round((arr.reduce((n, v) => n + v, 0) / arr.length) * 10) / 10;

  const banked = (es) => es.reduce((n, e) => n + (Number.isFinite(e.scored) ? e.scored : 0), 0);
  const yetToPlay = (es) => es.filter((e) => e.status !== "final").length;

  return {
    winProb: wins / RUNS,
    tieProb: ties / RUNS,
    myNow: Math.round(banked(myEntries) * 10) / 10,
    oppNow: Math.round(banked(oppEntries) * 10) / 10,
    myProjFinal: mean(totals),
    oppProjFinal: mean(oppTotals),
    myP10: q(sortedMine, 0.1),
    myP90: q(sortedMine, 0.9),
    myLeft: yetToPlay(myEntries),
    oppLeft: yetToPlay(oppEntries),
  };
}

/** Plain-English read on where the matchup stands. */
export function liveNarrative(sim) {
  if (!sim) return null;
  const p = sim.winProb;
  const lead = sim.myNow - sim.oppNow;
  const leftGap = sim.myLeft - sim.oppLeft;

  if (sim.myLeft === 0 && sim.oppLeft === 0) {
    // A dead-even final gives every run a === b, so wins stays 0 and winProb
    // is 0 — which read as "you lost" despite tieProb being 1.0. Check the
    // tie before the win/loss test.
    if (sim.tieProb > 0.5) return "Final — a tie.";
    return p > 0.5 ? "Final — you won." : "Final — you lost.";
  }
  if (sim.myLeft === 0) {
    return `Your lineup is done at ${sim.myNow}. ${sim.oppLeft} player${sim.oppLeft === 1 ? "" : "s"} left can still catch you.`;
  }
  if (sim.oppLeft === 0) {
    return `They're locked at ${sim.oppNow}. You need ${Math.max(0, Math.round((sim.oppNow - sim.myNow) * 10) / 10)} more from ${sim.myLeft} player${sim.myLeft === 1 ? "" : "s"}.`;
  }
  if (lead < 0 && leftGap > 0) {
    return `Down ${Math.abs(Math.round(lead * 10) / 10)} but with ${leftGap} more player${leftGap === 1 ? "" : "s"} to play — the scoreboard is lying to you.`;
  }
  if (lead > 0 && leftGap < 0) {
    return `Up ${Math.round(lead * 10) / 10}, but they have ${Math.abs(leftGap)} more still to play. Not as safe as it looks.`;
  }
  if (p > 0.85) return "Comfortable. Barring a disaster this is yours.";
  if (p < 0.15) return "Needs something unusual to happen.";
  return "Genuinely close — this comes down to the players still on the field.";
}

/**
 * Underdogs should chase ceiling, favourites should protect floor. Surfacing
 * this stops the app from recommending the "safe" play in a week where safe
 * loses 4 times out of 5.
 */
export function strategyAdvice(winProb) {
  if (winProb == null) return null;
  if (winProb < 0.35) {
    return {
      mode: "ceiling",
      text: "You're a clear underdog — take the high-ceiling player even at a lower projection. A safe lineup loses this matchup most weeks.",
    };
  }
  if (winProb > 0.68) {
    return {
      mode: "floor",
      text: "You're favoured — protect the floor. Avoid boom/bust starts; you win by not blowing up.",
    };
  }
  return { mode: "balanced", text: "Close matchup — start the highest projected points, variance barely matters here." };
}
