// ============================================================================
// ESPN scoring-category ids → the names ESPN's own app shows.
//
// Source: the stat-id table in the espn-fantasy-football-api package
// (scoringItemToId), which is ESPN's own numbering. Only the categories a
// league can score on are here; an id missing from this table renders as
// "Other (stat N)" rather than a guessed name.
// ============================================================================

const every = (n, what) => `Every ${n} ${what}`;

const L = {
  0: "Pass attempts", 1: "Completions", 2: "Incompletions",
  3: "Passing yards", 4: "TD pass",
  5: every(5, "passing yards"), 6: every(10, "passing yards"), 7: every(20, "passing yards"),
  8: every(25, "passing yards"), 9: every(50, "passing yards"), 10: every(100, "passing yards"),
  11: every(5, "completions"), 12: every(10, "completions"),
  13: every(5, "incompletions"), 14: every(10, "incompletions"),
  15: "40+ yd TD pass bonus", 16: "50+ yd TD pass bonus",
  17: "300–399 yd passing game", 18: "400+ yd passing game",
  19: "2-pt pass", 20: "Interception thrown", 21: "Completion %",
  23: "Rush attempts", 24: "Rushing yards", 25: "TD rush", 26: "2-pt rush",
  27: every(5, "rushing yards"), 28: every(10, "rushing yards"), 29: every(20, "rushing yards"),
  30: every(25, "rushing yards"), 31: every(50, "rushing yards"), 32: every(100, "rushing yards"),
  33: every(5, "rush attempts"), 34: every(10, "rush attempts"),
  35: "40+ yd TD rush bonus", 36: "50+ yd TD rush bonus",
  37: "100–199 yd rushing game", 38: "200+ yd rushing game",
  42: "Receiving yards", 43: "TD reception", 44: "2-pt reception",
  45: "40+ yd TD rec bonus", 46: "50+ yd TD rec bonus",
  47: every(5, "receiving yards"), 48: every(10, "receiving yards"), 49: every(20, "receiving yards"),
  50: every(25, "receiving yards"), 51: every(50, "receiving yards"), 52: every(100, "receiving yards"),
  53: "Receptions", 54: every(5, "receptions"), 55: every(10, "receptions"),
  56: "40+ yd TD rec bonus", 57: "50+ yd TD rec bonus",
  58: "Targets", 59: "Yards after catch", 60: "Yards per reception",
  68: "Fumbles", 72: "Fumble lost", 73: "Turnovers",
  74: "FG made 50+", 75: "FG attempted 50+", 76: "FG missed 50+",
  77: "FG made 40–49", 78: "FG attempted 40–49", 79: "FG missed 40–49",
  80: "FG made 0–39", 81: "FG attempted 0–39", 82: "FG missed 0–39",
  83: "FG made", 84: "FG attempted", 85: "FG missed",
  86: "PAT made", 87: "PAT attempted", 88: "PAT missed",
  89: "0 points allowed", 90: "1–6 points allowed", 91: "7–13 points allowed",
  92: "14–17 points allowed", 93: "Blocked kick TD",
  95: "Interception", 96: "Fumble recovered", 97: "Blocked kick", 98: "Safety",
  99: "Sack", 100: "Half sack",
  101: "Kickoff return TD", 102: "Punt return TD", 103: "Fumble return TD",
  104: "Interception return TD", 105: "Return TD",
  106: "Forced fumble", 107: "Assisted tackles", 108: "Solo tackles", 109: "Total tackles",
  110: every(3, "tackles"), 111: every(5, "tackles"), 112: "Stuffs",
  114: "Kickoff return yards", 115: "Punt return yards",
  120: "Points allowed",
  121: "18–21 points allowed", 122: "22–27 points allowed", 123: "28–34 points allowed",
  124: "35–45 points allowed", 125: "46+ points allowed",
  127: "Yards allowed", 128: "Under 100 yards allowed", 129: "100–199 yards allowed",
  130: "200–299 yards allowed", 132: "350–399 yards allowed",
  133: "400–449 yards allowed", 134: "450–499 yards allowed", 135: "500–549 yards allowed",
  136: "550+ yards allowed",
  198: "FG made 50–59", 199: "FG attempted 50–59", 200: "FG missed 50–59",
  201: "FG made 60+", 202: "FG attempted 60+", 203: "FG missed 60+",
  214: "FG yards", 215: "Missed FG yards",
};

export function espnStatLabel(id) {
  return L[id] || `Other (stat ${id})`;
}
