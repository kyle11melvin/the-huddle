// ============================================================================
// Paste-to-import parsers.
//
// Deliberately forgiving: fantasy sites all format differently and copy/paste
// mangles whitespace, so these scan for shapes rather than demanding a schema.
// Every parser returns what it *found* plus what it couldn't match, so the UI
// can show a preview before anything is written.
// ============================================================================

import { TEAMS } from "./data/teams.js";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const PARTICLES = new Set(["st", "st.", "van", "von", "de", "la", "le", "du"]);
const POS_TOKENS = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DST: "D/ST", "D/ST": "D/ST", DEF: "D/ST" };

export const normKey = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

// Declared before its first use, deliberately. A const referenced above its
// declaration is a temporal-dead-zone crash waiting for someone to call it
// during module init — the exact class of bug that blanked Start/Sit.
const TEAM_ABBRS = new Set(Object.keys(TEAMS));
const TEAM_ALIASES = { JAC: "JAX", WAS: "WSH", LA: "LAR", SD: "LAC", OAK: "LV", STL: "LAR", ARZ: "ARI", BLT: "BAL", HST: "HOU", CLV: "CLE" };
export const canonTeam = (t) => {
  const up = (t || "").toUpperCase();
  return TEAM_ABBRS.has(up) ? up : TEAM_ALIASES[up] || null;
};

/** Split a display name into a comparable {initial, last}. */
export function nameParts(raw) {
  const cleaned = (raw || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Za-z.'\- ]/g, " ")
    .trim();
  let tokens = cleaned.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1].replace(/\./g, "").toLowerCase())) {
    tokens.pop();
  }
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    return { first: "", initial: "", abbreviated: true, last: tokens[0].toLowerCase().replace(/[^a-z]/g, "") };
  }

  let last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  if (tokens.length > 2 && PARTICLES.has(prev.toLowerCase())) last = `${prev}${last}`;

  const first = tokens[0].toLowerCase().replace(/[^a-z]/g, "");
  return {
    first,
    initial: first[0] || "",
    // "T." / "T" is an initial; "Trevor" is a real first name
    abbreviated: tokens[0].replace(/[^A-Za-z]/g, "").length === 1,
    last: last.toLowerCase().replace(/[^a-z]/g, ""),
  };
}

const looksLikeDefense = (s) => /\bd\/?st\b|\bdefense\b|\bdef\b/i.test(s || "");

/** Defense identity with the D/ST decoration stripped: "Steelers D/ST" → "steelers". */
const defKey = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/\bd\/?st\b|\bdefense\b|\bdef\b/g, " ")
    .replace(/[^a-z]/g, "");

/**
 * Match a parsed row to a roster player.
 *
 * `hints` carries the team and position the row already told us. They were
 * being parsed and then thrown away, which is why five of a sixteen-man
 * roster failed to import: FantasyPros abbreviates first names on its
 * position pages, so "B. Robinson" matched BOTH Bijan Robinson and Brian
 * Robinson Jr., and "J. Williams" matched both Jameson and Javonte. The team
 * abbreviation sitting in the same row resolves every one of those.
 *
 * @param {{team?:string, pos?:string}} [hints]
 */
export function matchPlayer(rawName, players, hints = {}) {
  const hintTeam = canonTeam(hints.team) || null;
  const hintPos = hints.pos || "";

  // ---- team defenses ----
  // FantasyPros lists these by nickname alone ("Steelers"); we store
  // "Steelers D/ST". Name matching can't bridge that, but the team can.
  // `teamOnly` gates the match-on-team-alone shortcut. It is right when the
  // row has already identified itself as a defense, and catastrophic when it
  // has not: ANY unmatched row whose team happened to equal our D/ST's team
  // was handed to the defense. "26 QB Aaron Rodgers PIT" became ECR QB26 and
  // a 15.1 projection on a defense that projects 8.2, and the real DST row
  // was then swallowed as a duplicate.
  const matchDefense = ({ teamOnly = true } = {}) => {
    const defs = players.filter((p) => p.pos === "D/ST");
    if (!defs.length) return null;
    if (teamOnly && hintTeam) {
      const byTeam = defs.filter((p) => canonTeam(p.team) === hintTeam);
      if (byTeam.length === 1) return { match: byTeam[0], ambiguous: false };
    }
    const k = defKey(rawName);
    const byName = k
      ? defs.filter((p) => {
          const pk = defKey(p.name);
          return pk && (pk.includes(k) || k.includes(pk));
        })
      : [];
    if (byName.length === 1) return { match: byName[0], ambiguous: false };
    if (byName.length > 1) return { match: null, ambiguous: true, candidates: byName };
    return null;
  };

  if (hintPos === "D/ST" || looksLikeDefense(rawName)) {
    const d = matchDefense();
    if (d) return d;
  }

  const want = nameParts(rawName);
  if (!want || !want.last) return { match: null, ambiguous: false };
  let hits = players.filter((p) => {
    const have = nameParts(p.name);
    if (!have || have.last !== want.last) return false;
    if (!want.first || !have.first) return true;
    // Both first names spelled out — compare them in full so "Bijan Robinson"
    // does not collide with "Brian Robinson Jr.". Only fall back to the initial
    // when one side is genuinely abbreviated ("B. Robinson").
    if (!want.abbreviated && !have.abbreviated) return want.first === have.first;
    return want.initial === have.initial;
  });

  // Narrow an initial-collision with what the row already told us. Filters are
  // applied only when they leave something behind — a stale team on our side
  // (a traded player) must not turn a findable match into a miss.
  if (hits.length > 1 && hintTeam) {
    const byTeam = hits.filter((p) => canonTeam(p.team) === hintTeam);
    if (byTeam.length) hits = byTeam;
  }
  if (hits.length > 1 && hintPos) {
    const byPos = hits.filter((p) => p.pos === hintPos);
    if (byPos.length) hits = byPos;
  }

  if (hits.length === 1) return { match: hits[0], ambiguous: false };
  if (hits.length > 1) return { match: null, ambiguous: true, candidates: hits };

  // Last resort: a bare nickname like "Steelers" carries no position token
  // and no surname our roster would recognise, so nothing above fires.
  //
  // Two guards, because the two import paths carry different evidence and
  // neither guard covers the other's path:
  //
  //   1. A row that DECLARED a position is not a defense — if it had said
  //      D/ST the branch above would already have matched it. The rankings
  //      paste carries positions, so this is what protects that path.
  //   2. The FantasyPros projections CSV has no position column, so nothing
  //      is declared there and guard 1 cannot fire. What still distinguishes
  //      them is the name: "Steelers" is one token, "Aaron Rodgers" is a
  //      person. A personal name may still reach a defense BY NAME, it just
  //      may not be handed one on a team match alone.
  if (!hintPos) {
    const d = matchDefense({ teamOnly: !want.first });
    if (d) return d;
  }
  return { match: null, ambiguous: false };
}

/**
 * Parse a ranking table. Handles rows like:
 *   "11 T. Lawrence JAC"        (FantasyPros position ranks)
 *   "2. B. Robinson RB - ATL"   (FantasyPros overall/FLEX)
 *   "13  C. Brown  RB - CIN"
 * @param {string} defaultPos position to assume when a row omits one
 * @returns {{rows: Array<{rank,name,team,pos}>, skipped: number}}
 */
export function parseRankings(text, defaultPos = "") {
  const rows = [];
  let skipped = 0;
  for (const rawLine of (text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = /^(\d{1,3})\s*[.)\]]?\s+(.*)$/.exec(line);
    if (!m) {
      if (/[A-Za-z]/.test(line)) skipped++;
      continue;
    }
    const rank = parseInt(m[1], 10);
    let rest = m[2].trim();
    if (!rest || rank < 1 || rank > 400) {
      skipped++;
      continue;
    }

    // position token, wherever it sits
    let pos = "";
    rest = rest.replace(/\b(QB|RB|WR|TE|K|DST|DEF|D\/ST)\b/gi, (tok) => {
      if (!pos) pos = POS_TOKENS[tok.toUpperCase()] || "";
      return " ";
    });

    // trailing team abbreviation (optionally after a dash)
    let team = "";
    const teamMatch = /[-–—]?\s*([A-Za-z]{2,3})\s*$/.exec(rest);
    if (teamMatch) {
      const c = canonTeam(teamMatch[1]);
      if (c) {
        team = c;
        rest = rest.slice(0, teamMatch.index).trim();
      }
    }

    const name = rest.replace(/[-–—]+\s*$/, "").replace(/\s+/g, " ").trim();
    if (!name || name.length < 2) {
      skipped++;
      continue;
    }
    rows.push({ rank, name, team, pos: pos || defaultPos });
  }
  return { rows, skipped };
}

/**
 * Build the league-wide ECR index consumed by analysis.leagueStrength.
 *
 * `existing` is LAYERED UNDER, not min-merged with, the rows being imported:
 * the newest rank for a name wins outright. This used to keep the lowest rank
 * ever seen, which reads as sensible and is correct within a single paste, but
 * is wrong the moment a second week arrives — a WR who fell from 12 to 40 in
 * Week 2 stayed indexed at 12 for the rest of the season, with no UI to clear
 * it. That is not a cosmetic number: ecrIndex outranks ESPN's live autoRanks
 * in analysis.liveRankInfo and prices the opponent sim through rankToPoints.
 *
 * The merge is where the fix belongs rather than the call site. FantasyPros
 * publishes one page per position and the panel has a position selector for
 * exactly that, so a week's import is several pastes in a row; building fresh
 * from `rows` alone would make the RB paste erase the QB paste from two
 * minutes earlier. Ranks that a paste doesn't mention are carried forward
 * untouched — a name only changes when a newer paste names it.
 *
 * (Per-position ranks share one numeric space here, so "lowest wins" was also
 * comparing a WR's 12 against an RB's 12 as though they were the same claim.)
 *
 * @param {Array<{rank:number,name:string}>} rows the paste being applied
 * @param {Object} existing the index built by earlier pastes
 * @returns {Object} normalizedName -> rank
 */
export function buildEcrIndex(rows, existing = {}) {
  const out = { ...existing };
  for (const r of rows) {
    const key = normKey(r.name);
    if (!key) continue;
    out[key] = r.rank; // newest paste wins, better or worse
  }
  return out;
}

/**
 * Apply parsed rankings to your roster's ECR strings.
 *
 * Every row lands in exactly ONE bucket, and the buckets sum to rows.length.
 * Two of them used to be a bare `continue`, so a paste could report "633
 * parsed / 16 matched / 597 not on your roster" with 20 rows counted nowhere
 * and nothing on screen saying so.
 *
 * @returns {{updates, unchanged, duplicate, unmatched, ambiguous}}
 */
export function planEcrUpdates(rows, players) {
  const updates = [];
  const unchanged = []; // matched, but the ECR string is already this value
  const duplicate = []; // matched a player an earlier row already claimed
  const unmatched = [];
  const ambiguous = [];
  const claimed = new Set();

  for (const r of rows) {
    // Pass the row's own team and position through — they were parsed and
    // then discarded, which is what made the initial-collisions unresolvable.
    const { match, ambiguous: amb } = matchPlayer(r.name, players, { team: r.team, pos: r.pos });
    if (amb) {
      ambiguous.push(r);
      continue;
    }
    if (!match) {
      unmatched.push(r);
      continue;
    }
    if (claimed.has(match.id)) {
      duplicate.push({ ...r, claimedBy: match.name });
      continue;
    }
    // Claim on every match, not only on a change. Claiming inside the branch
    // below meant a row that matched but changed nothing left the player
    // unclaimed, so a LATER row for him still won — "first rank wins" was
    // false in exactly the case where the first rank was already applied,
    // which is the sentence the duplicate warning puts on screen. The
    // projections path has always claimed on every match; this matches it.
    claimed.add(match.id);
    const pos = r.pos || match.pos;
    const nextEcr = `${pos === "D/ST" ? "DST" : pos}${r.rank}`;
    if (nextEcr !== match.ecr) {
      updates.push({ id: match.id, name: match.name, from: match.ecr || "—", to: nextEcr });
    } else {
      unchanged.push({ ...r, claimedBy: match.name });
    }
  }
  return { updates, unchanged, duplicate, unmatched, ambiguous };
}

// ------------------------------------------ FantasyPros projections ----------

/** Split one CSV line, honouring quoted fields that contain commas. */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if ((c === "," || c === "\t") && !inQ) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** "3 out of 5 stars" | "★★★" | a bare 0–5 → 3 */
function parseStars(raw) {
  if (raw == null) return null;
  const s = String(raw);
  const glyphs = (s.match(/[★✩☆]/g) || []).filter((g) => g === "★").length;
  if (glyphs > 0) return Math.min(5, glyphs);
  const outOf = /(\d(?:\.\d)?)\s*(?:out of\s*)?5?\s*stars?/i.exec(s);
  if (outOf) return Math.min(5, Math.round(parseFloat(outOf[1])));
  const bare = /^\s*([0-5])\s*$/.exec(s);
  return bare ? parseInt(bare[1], 10) : null;
}

/**
 * Parse a FantasyPros weekly export carrying a projection column.
 *
 * Accepts a pasted CSV (with or without its header row) or the whitespace
 * table you get from copying the page. Deliberately forgiving in the same way
 * the ranking parser is — 17 weeks of hand-converting a CSV is 17 chances to
 * make a transcription error.
 *
 * Captures the matchup star rating in the same pass. That is CONTEXT ONLY —
 * see pointDistribution: FantasyPros' own projection already prices the
 * matchup, so feeding the stars in as well would double-count it.
 *
 * @returns {{rows, matched, duplicate, unmatched, ambiguous, skipped, sawHeader}}
 */
export function parseProjections(text, rosterPlayers = []) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.replace(/ /g, " ").trim()).filter(Boolean);
  const rows = [];
  let skipped = 0;
  let sawHeader = false;

  // Header-driven path: the CSV export names its columns, so use them.
  let col = null;
  if (lines.length) {
    const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const find = (re) => head.findIndex((h) => re.test(h));
    const nameCol = find(/player|name/);
    const projCol = find(/proj.*(fpts|pts|points)|^fpts$|^proj$/);
    if (nameCol >= 0 && projCol >= 0) {
      sawHeader = true;
      col = {
        name: nameCol,
        proj: projCol,
        team: find(/^team$/),
        pos: find(/^pos/),
        opp: find(/^opp/),
        stars: find(/matchup|star/),
      };
    }
  }

  for (let i = sawHeader ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(rk|rank|tiers?)\b/i.test(line) && !sawHeader) continue;

    let name = "";
    let team = "";
    let pos = "";
    let proj = null;
    let stars = null;

    if (col) {
      const f = splitCsvLine(line);
      name = f[col.name] || "";
      proj = parseFloat(String(f[col.proj] || "").replace(/[^0-9.-]/g, ""));
      team = col.team >= 0 ? canonTeam(f[col.team]) || "" : "";
      pos = col.pos >= 0 ? POS_TOKENS[(f[col.pos] || "").toUpperCase().replace(/\d+$/, "")] || "" : "";
      stars = col.stars >= 0 ? parseStars(f[col.stars]) : null;
    } else {
      // Free-form: "1 Ja'Marr Chase CIN @CLE 3 out of 5 stars 18.7"
      let rest = line.replace(/^\s*\d{1,3}\s*[.)\]]?\s+/, "");
      stars = parseStars(rest);
      rest = rest.replace(/\d(?:\.\d)?\s*(?:out of\s*)?5?\s*stars?/i, " ").replace(/[★✩☆]/g, " ");
      // the projection is the last decimal on the line
      const nums = rest.match(/-?\d+\.\d+|\b\d+\b/g) || [];
      if (nums.length) proj = parseFloat(nums[nums.length - 1]);
      rest = rest.replace(/(-?\d+\.\d+|\b\d+\b)\s*$/, " ");
      // Opponent. NO leading \b before the @ — "@" is not a word character, so
      // \b never matches there and "@CLE" survived, after which the team
      // regex below happily grabbed the OPPONENT as the team and left
      // "Chase Brown CIN @" as the name.
      rest = rest.replace(/(?:\bvs\.?\s*|@\s*)[A-Za-z]{2,3}\b/gi, " ");
      rest = rest.replace(/\b(QB|RB|WR|TE|K|DST|DEF|D\/ST)\d*\b/gi, (t) => {
        if (!pos) pos = POS_TOKENS[t.toUpperCase().replace(/\d+$/, "")] || "";
        return " ";
      });
      const tm = /\b([A-Za-z]{2,3})\b\s*$/.exec(rest.trim());
      if (tm && canonTeam(tm[1])) {
        team = canonTeam(tm[1]);
        rest = rest.slice(0, tm.index);
      }
      // "Chase Brown RB - CIN" leaves a dangling separator once the position
      // and team are lifted out; the rankings parser already strips these.
      name = rest
        .replace(/\s+/g, " ")
        .replace(/[-–—]+\s*$/, "")
        .replace(/^\s*[-–—]+/, "")
        .trim();
    }

    if (!name || !Number.isFinite(proj)) {
      if (/[A-Za-z]/.test(line)) skipped++;
      continue;
    }
    rows.push({ name, team, pos, proj: Math.round(proj * 10) / 10, stars });
  }

  // Same matcher the rankings import uses — team/pos hints included, which is
  // what makes the surname collisions on this roster resolvable.
  const matched = [];
  const duplicate = []; // matched a player an earlier row already claimed
  const unmatched = [];
  const ambiguous = [];
  const claimed = new Set();
  for (const r of rows) {
    const { match, ambiguous: amb } = matchPlayer(r.name, rosterPlayers, { team: r.team, pos: r.pos });
    if (amb) ambiguous.push(r);
    else if (!match) unmatched.push(r);
    else if (!claimed.has(match.id)) {
      claimed.add(match.id);
      matched.push({ player: match, proj: r.proj, stars: r.stars, team: r.team });
    } else duplicate.push({ ...r, claimedBy: match.name });
  }
  return { rows, matched, duplicate, unmatched, ambiguous, skipped, sawHeader };
}

// ------------------------------------- FantasyPros "Who Should I Start" ------

/** Row label -> the analytics key it feeds. Rushing/receiving variants merge. */
const WSIS_LABELS = [
  [/^opponent$/i, "opponent", "text"],
  [/^matchup rating$/i, "matchupRating", "num"],
  [/^(receptions|targets) allowed$/i, "dvpReceptions", "num"],
  [/^receiving yards allowed$/i, "dvpYards", "num"],
  [/^receiving tds allowed$/i, "dvpTds", "num"],
  [/^rushing att(empts)? allowed$/i, "dvpAttempts", "num"],
  [/^rushing yds allowed$/i, "dvpYards", "num"],
  [/^rushing tds allowed$/i, "dvpTds", "num"],
  [/^total matchup points o\/u/i, "ouGameTotal", "num"],
  [/^(receiving|rush(ing)?) yards o\/u/i, "ouYards", "num"],
  [/^season total$/i, "seasonTotal", "num"],
  [/^season avg\.?$/i, "seasonAvg", "num"],
  [/^projection avg\.?$/i, "proj", "num"],
  [/^\d{4} avg\.?$/i, "priorAvg", "num"],
  [/^injury status$/i, "injury", "text"],
  [/^weather$/i, "weather", "text"],
  [/^opportunity/i, "rzOpportunity", "num"],
  [/^efficiency/i, "rzEfficiency", "num"],
];

const isBlankToken = (t) => !t || /^(-|–|—|n\/a)$/i.test(t.trim());

function splitCells(line) {
  return line
    .split(/\t+|\s{2,}|\s*\|\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const toNum = (t) => {
  if (isBlankToken(t)) return null;
  const n = parseFloat(String(t).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse a pasted FantasyPros comparison. Columns are identified by matching
 * against YOUR roster, so the parser doesn't have to guess which tokens are
 * names — and a paste that doesn't mention your players fails loudly instead
 * of silently writing garbage.
 *
 * @param {string} text pasted page content
 * @param {Array} rosterPlayers state.players values
 * @returns {{columns, stats, experts, warnings}}
 */
export function parseStartSit(text, rosterPlayers) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.replace(/ /g, " ").trim());
  const warnings = [];

  // ---- 1. which of my players appear, in column order ----
  const seen = [];
  for (const line of lines) {
    for (const cell of splitCells(line)) {
      if (cell.length < 3 || /^\d/.test(cell)) continue;
      const { match } = matchPlayer(cell, rosterPlayers);
      if (match && !seen.some((s) => s.id === match.id)) seen.push(match);
    }
    if (seen.length >= 4) break;
  }
  if (seen.length < 2) {
    return {
      columns: seen,
      stats: {},
      experts: [],
      warnings: ["Couldn't find at least two of your players in that paste — copy the comparison header too."],
    };
  }
  const n = seen.length;

  /** Collect n values for a label, spilling onto following lines if needed. */
  const valuesAfter = (startIdx, firstRemainder) => {
    const vals = [...splitCells(firstRemainder || "")];
    let i = startIdx + 1;
    while (vals.length < n && i < lines.length && i < startIdx + 8) {
      const cells = splitCells(lines[i]);
      // a new label line means the row simply had fewer values
      if (cells.length === 1 && WSIS_LABELS.some(([re]) => re.test(cells[0]))) break;
      vals.push(...cells);
      i++;
    }
    return vals.slice(0, n);
  };

  // ---- 2. labelled stat rows ----
  const stats = {};
  lines.forEach((line, idx) => {
    if (!line) return;
    const cells = splitCells(line);
    if (!cells.length) return;
    const label = cells[0];
    const hit = WSIS_LABELS.find(([re]) => re.test(label));
    if (!hit) return;
    const [, key, kind] = hit;
    const remainder = line.slice(label.length);
    const raw = valuesAfter(idx, remainder);
    if (!raw.length) return;
    const vals = raw.map((v) => (kind === "num" ? toNum(v) : isBlankToken(v) ? null : v));
    // don't let a later blank row wipe a populated one
    if (stats[key] && vals.every((v) => v == null)) return;
    stats[key] = vals;
  });

  // ---- 3. expert rank rows: any line carrying n "#NN" tokens ----
  const experts = [];
  for (const line of lines) {
    const hashes = line.match(/#\s?\d{1,3}/g);
    if (!hashes || hashes.length < 2) continue;
    const ranks = hashes.slice(0, n).map((h) => parseInt(h.replace(/[^0-9]/g, ""), 10));
    const before = line.slice(0, line.indexOf(hashes[0])).trim();
    const record = (before.match(/\b(\d{1,3})\s*-\s*(\d{1,3})\b/) || [])[0] || "";
    const name = before
      .replace(/\b\d{1,3}\s*-\s*\d{1,3}\b/, "")
      .replace(/\(([^)]*)\)/, " ($1)")
      .replace(/\s+/g, " ")
      .trim();
    if (ranks.length >= 2) experts.push({ expert: name || "Expert", record, ranks });
  }
  if (!experts.length) warnings.push("No expert ranks found — the rank dispersion view needs that section.");
  if (!stats.proj) warnings.push("No 'Projection Avg' row found — projections drive the simulation.");

  return { columns: seen, stats, experts, warnings };
}

/** Reshape a parsed comparison into per-player analytics patches. */
export function startSitToAnalytics(parsed) {
  const out = [];
  parsed.columns.forEach((player, i) => {
    const pick = (key) => (parsed.stats[key] ? parsed.stats[key][i] : null);
    const expertRanks = parsed.experts
      .map((e) => ({ expert: e.expert, record: e.record, rank: e.ranks[i] }))
      .filter((e) => Number.isFinite(e.rank));
    // Only fields the projection engine actually consumes. The old
    // matchupRating/dvp/weather/ou captures were stored but never read —
    // game environment now comes live from Vegas lines, and a real
    // schedule-adjusted DvP model needs actual game logs (season-start build).
    const patch = {
      opponent: pick("opponent"),
      proj: pick("proj"),
      seasonAvg: pick("seasonAvg"),
      seasonTotal: pick("seasonTotal"),
      injury: pick("injury"),
      expertRanks,
    };
    Object.keys(patch).forEach((k) => {
      if (patch[k] == null) delete patch[k];
    });
    out.push({ player, patch });
  });
  return out;
}

/**
 * Parse a bye-week table. Handles "ARI 8", "Cardinals - 8", "ARI\t8",
 * and multi-column dumps like "ARI 8 ATL 5 BAL 7".
 * @returns {{byes: Object, found: number}}
 */
export function parseByes(text) {
  const byes = {};
  const nameToAbbr = {};
  for (const [abbr, t] of Object.entries(TEAMS)) {
    nameToAbbr[t.name.toLowerCase()] = abbr;
    nameToAbbr[abbr.toLowerCase()] = abbr;
  }

  const tokens = (text || "").split(/[\s,|\t]+/).filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i].replace(/[^A-Za-z]/g, "").toLowerCase();
    let abbr = nameToAbbr[key] || canonTeam(key);
    if (!abbr) continue;
    // find the next numeric token within a short window
    for (let j = i + 1; j < Math.min(i + 3, tokens.length); j++) {
      const num = tokens[j].replace(/[^0-9]/g, "");
      if (!num) continue;
      const w = parseInt(num, 10);
      if (w >= 1 && w <= 18) {
        byes[abbr] = w;
        i = j;
      }
      break;
    }
  }
  return { byes, found: Object.keys(byes).length };
}
