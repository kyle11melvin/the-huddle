// ============================================================================
// Pair two lineups slot-for-slot, for the head-to-head Gameday board.
//
// Pure, so the pairing can be asserted without rendering. The whole value of
// the layout is that row N on the left and row N on the right are the SAME
// slot — if that alignment is ever wrong the screen is actively misleading,
// showing a QB opposite a kicker and inviting a comparison that isn't real.
// ============================================================================

/** Slot display order. Bench and IR are excluded — see pairBySlot. */
export const H2H_SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K"];

const rank = (slot) => {
  const i = H2H_SLOT_ORDER.indexOf(slot);
  return i === -1 ? H2H_SLOT_ORDER.length : i;
};

/**
 * @param {Array} mine   resolved rows for my side
 * @param {Array} theirs resolved rows for the opponent
 * @returns {Array<{key:string, slot:string, mine:object|null, theirs:object|null}>}
 *
 * Starters only: bench has no counterpart to pair against, so pairing it would
 * invent an opponent that doesn't exist.
 *
 * Sorted by SLOT, never by live status. The two-column board sorts the way it
 * does precisely so the rows line up; ordering by "in progress first" would
 * slide one side against the other and break the only thing the layout is for.
 *
 * Sides can legitimately differ in depth — a league with different roster
 * settings, or an opponent missing a starter — so each slot zips to the LONGER
 * side and the short side gets nulls rather than dropping the extra player.
 */
export function pairBySlot(mine = [], theirs = []) {
  const bucket = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!r || !r.slot) continue;
      if (r.slot === "BE" || r.slot === "IR") continue;
      if (!m.has(r.slot)) m.set(r.slot, []);
      m.get(r.slot).push(r);
    }
    return m;
  };

  const a = bucket(mine);
  const b = bucket(theirs);
  const slots = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));

  const out = [];
  for (const slot of slots) {
    const L = a.get(slot) || [];
    const Rr = b.get(slot) || [];
    for (let i = 0; i < Math.max(L.length, Rr.length); i++) {
      out.push({
        key: `${slot}:${i}`,
        slot,
        mine: L[i] || null,
        theirs: Rr[i] || null,
      });
    }
  }
  return out;
}

/**
 * "Trevor Lawrence" -> "T. Lawrence". Full names do not fit a two-column
 * board: at phone width the name column is roughly half a screen, and the raw
 * string truncates to "Trevor..." / "Matth...", which is worse than useless
 * when the whole point is comparing two players at a glance.
 *
 * Defenses and anything single-word are returned untouched — "Steelers" is
 * already the short form, and "S. teelers" would be nonsense.
 */
export function shortName(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  // Defenses are named for the team, not a person: "Lions D/ST" must not
  // become "L. D/ST", which reads as a player whose surname is a slot.
  if (/\bD\/?ST\b/i.test(n)) return n.replace(/\s*D\/?ST\b/i, "").trim() || n;
  const parts = n.split(/\s+/);
  if (parts.length < 2) return n;
  // Keep suffixes attached to the surname: "Mike Washington Jr." -> "M. Washington Jr."
  const [first, ...rest] = parts;
  return `${first.charAt(0)}. ${rest.join(" ")}`;
}
