// ============================================================================
// Alert engine — the app's findings, pushed at the user instead of waiting
// to be found. Every alert is derived from real synced data; each has a
// stable id so a dismissal sticks until the underlying fact changes.
// ============================================================================

import { lineupWarnings } from "./analysis.js";
import { byeCliffs } from "./scheduleSync.js";
import { SLOT_DEFS } from "./lineup.js";

const POS_LABEL = { QB: "a QB", RB: "an RB", WR: "a WR", TE: "a TE", "D/ST": "a D/ST", K: "a kicker" };

/** @returns Array<{id, level:'red'|'gold'|'blue', icon, title, body, tab, dismissible}> */
export function buildAlerts(state) {
  const out = [];
  const week = state.week;
  const cw = parseInt(week, 10) || 0; // PRE counts as before week 1

  // ---- 1. lineup problems THIS week: not dismissible, fix them instead ----
  const problems = lineupWarnings(state, week).filter((w) => w.level === "error");
  if (problems.length) {
    out.push({
      id: `lineup-${week}`,
      level: "red",
      icon: "🚨",
      title: `${problems.length} lineup problem${problems.length === 1 ? "" : "s"} this week`,
      body: problems.map((p) => p.text).join(" "),
      tab: "roster",
      dismissible: false,
    });
  }

  // ---- 2. injured players in starting slots ----
  const starters = new Set();
  for (const s of SLOT_DEFS) for (const id of state.lineup[s.key]) if (id) starters.add(id);
  for (const id of starters) {
    const p = state.players[id];
    if (p && (p.status === "Q" || p.status === "D")) {
      out.push({
        id: `inj-${p.id}-${p.status}`,
        level: "gold",
        icon: "🩹",
        title: `${p.name} is ${p.status === "Q" ? "questionable" : "doubtful"}`,
        body: `He's in your starting lineup — check the Start/Sit Lab before lock.`,
        tab: "lab",
        dismissible: true,
      });
    }
  }

  // ---- 3. bye cliffs: near ones, and monster ones regardless of distance ----
  for (const c of byeCliffs(state)) {
    const near = c.week > cw && c.week <= cw + 4;
    const monster = c.players.length >= 4;
    if (!c.cliff || (!near && !monster)) continue;
    const posSet = [...new Set(c.players.map((n) => Object.values(state.players).find((p) => p.name === n)?.pos).filter(Boolean))];
    const stockUp = posSet.length ? ` Stock up on ${posSet.map((p) => POS_LABEL[p] || p).join(", ")} before week ${c.week - 1 || c.week}.` : "";
    out.push({
      id: `cliff-${c.week}-${c.players.length}`,
      level: monster ? "red" : "gold",
      icon: "📅",
      title: `Week ${c.week}: ${c.players.length} of your players on bye at once`,
      body: `${c.players.join(", ")}.${stockUp} Waiver help is cheapest before everyone needs it.`,
      tab: "intel",
      dismissible: true,
    });
  }

  // ---- 4. stale ESPN link ----
  if (state.espn && Date.now() - (state.espn.fetchedAt || 0) > 24 * 3600 * 1000) {
    out.push({
      id: "espn-stale",
      level: "blue",
      icon: "⟳",
      title: "ESPN data is over a day old",
      body: "Tap the ESPN button to refresh rosters, injuries and projections.",
      tab: "roster",
      dismissible: true,
    });
  }

  const dismissed = state.alertsDismissed || {};
  const rank = { red: 0, gold: 1, blue: 2 };
  return out
    .filter((a) => !(a.dismissible && dismissed[a.id]))
    .sort((a, b) => rank[a.level] - rank[b.level]);
}
