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

/** "T. Lawrence" matches "Trevor Lawrence"; "B. Robinson" won't match "Brian Robinson Jr." vs "Bijan" ambiguity is reported. */
export function matchPlayer(rawName, players) {
  const want = nameParts(rawName);
  if (!want || !want.last) return { match: null, ambiguous: false };
  const hits = players.filter((p) => {
    const have = nameParts(p.name);
    if (!have || have.last !== want.last) return false;
    if (!want.first || !have.first) return true;
    // Both first names spelled out — compare them in full so "Bijan Robinson"
    // does not collide with "Brian Robinson Jr.". Only fall back to the initial
    // when one side is genuinely abbreviated ("B. Robinson"), which stays
    // ambiguous and gets reported rather than guessed.
    if (!want.abbreviated && !have.abbreviated) return want.first === have.first;
    return want.initial === have.initial;
  });
  if (hits.length === 1) return { match: hits[0], ambiguous: false };
  if (hits.length > 1) return { match: null, ambiguous: true, candidates: hits };
  return { match: null, ambiguous: false };
}

const TEAM_ABBRS = new Set(Object.keys(TEAMS));
const TEAM_ALIASES = { JAC: "JAX", WAS: "WSH", LA: "LAR", SD: "LAC", OAK: "LV", STL: "LAR", ARZ: "ARI", BLT: "BAL", HST: "HOU", CLV: "CLE" };
export const canonTeam = (t) => {
  const up = (t || "").toUpperCase();
  return TEAM_ABBRS.has(up) ? up : TEAM_ALIASES[up] || null;
};

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
 * @returns {Object} normalizedName -> rank
 */
export function buildEcrIndex(rows, existing = {}) {
  const out = { ...existing };
  for (const r of rows) {
    const key = normKey(r.name);
    if (!key) continue;
    // keep the best (lowest) rank seen for a name
    if (out[key] == null || r.rank < out[key]) out[key] = r.rank;
  }
  return out;
}

/**
 * Apply parsed rankings to your roster's ECR strings.
 * @returns {{updates: Array, unmatched: Array, ambiguous: Array}}
 */
export function planEcrUpdates(rows, players) {
  const updates = [];
  const unmatched = [];
  const ambiguous = [];
  const claimed = new Set();

  for (const r of rows) {
    const { match, ambiguous: amb } = matchPlayer(r.name, players);
    if (amb) {
      ambiguous.push(r);
      continue;
    }
    if (!match) {
      unmatched.push(r);
      continue;
    }
    if (claimed.has(match.id)) continue;
    const pos = r.pos || match.pos;
    const nextEcr = `${pos === "D/ST" ? "DST" : pos}${r.rank}`;
    if (nextEcr !== match.ecr) {
      updates.push({ id: match.id, name: match.name, from: match.ecr || "—", to: nextEcr });
      claimed.add(match.id);
    }
  }
  return { updates, unmatched, ambiguous };
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
  const n = parseFloat(String(t).replace(/[^0-9.\-]/g, ""));
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
    const patch = {
      opponent: pick("opponent"),
      matchupRating: pick("matchupRating"),
      proj: pick("proj"),
      seasonAvg: pick("seasonAvg"),
      seasonTotal: pick("seasonTotal"),
      injury: pick("injury"),
      weather: pick("weather"),
      rzOpportunity: pick("rzOpportunity"),
      dvp: {
        receptions: pick("dvpReceptions"),
        attempts: pick("dvpAttempts"),
        yards: pick("dvpYards"),
        tds: pick("dvpTds"),
      },
      ou: { gameTotal: pick("ouGameTotal"), yards: pick("ouYards") },
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
