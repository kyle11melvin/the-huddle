// Diagnostic: run Kyle's real 16-man roster against realistic FantasyPros
// row formats and report exactly which players fail to match, and why.
import { parseRankings, planEcrUpdates } from "../src/importer.js";

const ROSTER = [
  ["Trevor Lawrence", "JAX", "QB"],
  ["Bijan Robinson", "ATL", "RB"],
  ["Chase Brown", "CIN", "RB"],
  ["Tee Higgins", "CIN", "WR"],
  ["Jameson Williams", "DET", "WR"],
  ["Parker Washington", "JAX", "WR"],
  ["Brock Bowers", "LV", "TE"],
  ["Javonte Williams", "DAL", "RB"],
  ["Steelers D/ST", "PIT", "D/ST"],
  ["Cameron Dicker", "LAC", "K"],
  ["Quentin Johnston", "LAC", "WR"],
  ["Makai Lemon", "PHI", "WR"],
  ["Rachaad White", "TB", "RB"],
  ["Brian Robinson Jr.", "SF", "RB"],
  ["Romeo Doubs", "GB", "WR"],
  ["Jayden Higgins", "HOU", "WR"],
].map(([name, team, pos], i) => ({ id: `p${i}`, name, team, pos, ecr: "" }));

// FantasyPros abbreviates the first name on its position pages, and writes
// team defenses by nickname alone.
const abbrev = (n) => {
  if (/D\/ST/.test(n)) return n.replace(/\s*D\/ST/, "");
  const t = n.split(" ");
  return `${t[0][0]}. ${t.slice(1).join(" ")}`;
};

const FORMATS = {
  "abbreviated first name (position pages)": ROSTER.map(
    (p, i) => `${i + 1} ${abbrev(p.name)} ${p.team}`
  ),
  "full name (overall/CSV exports)": ROSTER.map(
    (p, i) => `${i + 1}. ${p.name.replace(/\s*D\/ST/, "")} ${p.pos === "D/ST" ? "DST" : p.pos} - ${p.team}`
  ),
};

for (const [label, lines] of Object.entries(FORMATS)) {
  const { rows, skipped } = parseRankings(lines.join("\n"));
  const plan = planEcrUpdates(rows, ROSTER);
  const matchedIds = new Set(plan.updates.map((u) => u.id));
  const missed = ROSTER.filter((p) => !matchedIds.has(p.id));
  console.log(`\n=== ${label} ===`);
  console.log(`parsed ${rows.length}/${lines.length} rows (skipped ${skipped})`);
  console.log(`matched ${matchedIds.size}/${ROSTER.length}`);
  if (missed.length) {
    console.log("MISSED:");
    for (const p of missed) {
      const amb = plan.ambiguous.some((r) => r.name.toLowerCase().includes(p.name.split(" ").pop().toLowerCase()));
      console.log(`  · ${p.name.padEnd(20)} ${p.pos.padEnd(5)} ${p.team.padEnd(4)} ${amb ? "→ AMBIGUOUS (shared surname)" : "→ no match"}`);
    }
  }
  if (plan.ambiguous.length) console.log("ambiguous rows:", plan.ambiguous.map((r) => r.name));
  if (plan.unmatched.length) console.log("unmatched rows:", plan.unmatched.map((r) => r.name));
}
