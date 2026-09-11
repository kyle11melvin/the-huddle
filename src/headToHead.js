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

/**
 * What firepower is left, by slot — not just how much.
 *
 * "yet to play (10)" hides the difference between a QB, three RBs and three
 * WRs still to come, and a kicker plus a defense. That distinction is the
 * whole read on whether a lead is comfortable or cooked, so the breakdown is
 * the number worth showing.
 *
 * Counts a player as yet to play when his game has not started. In progress
 * counts as played — he is already accruing.
 *
 * @returns {{count:number, parts:Array<{pos:string, n:number}>}}
 */
export function yetToPlay(rows = []) {
  const order = ["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K"];
  const tally = new Map();
  let count = 0;
  for (const r of rows) {
    if (!r || !r.name) continue;
    if (r.slot === "BE" || r.slot === "IR") continue;
    const status = (r.l && r.l.status) || "notStarted";
    if (status !== "notStarted") continue;
    count++;
    const key = r.slot === "FLEX" ? r.pos || "FLEX" : r.slot;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const parts = [...tally.entries()]
    .sort((a, b) => {
      const i = order.indexOf(a[0]);
      const j = order.indexOf(b[0]);
      return (i === -1 ? 99 : i) - (j === -1 ? 99 : j);
    })
    .map(([pos, n]) => ({ pos, n }));
  return { count, parts };
}

/** "QB, 3 RB, 3 WR, TE, K, DEF" — a bare 1 is left implicit, as Sleeper does. */
export function yetToPlayLabel(breakdown) {
  if (!breakdown || !breakdown.parts.length) return "";
  return breakdown.parts.map(({ pos, n }) => `${n > 1 ? `${n} ` : ""}${pos === "D/ST" ? "DEF" : pos}`).join(", ");
}

/**
 * Standings seed, 1-based. Wins first, then points for as the tiebreak.
 *
 * Week 1 every team is 0-0, so this is near-arbitrary until games are played —
 * which is honest rather than a defect, but worth knowing before reading much
 * into "#4" on opening weekend.
 */
export function seedFor(teams = [], teamId) {
  const ranked = [...teams]
    .filter((t) => t && t.record)
    .sort((a, b) => {
      const w = (b.record.w || 0) - (a.record.w || 0);
      if (w !== 0) return w;
      return (b.pointsFor || 0) - (a.pointsFor || 0);
    });
  const i = ranked.findIndex((t) => t.id === teamId);
  return i === -1 ? null : i + 1;
}

/** "0-0" or "2-1-1" — ties only shown when there are any. */
export function recordLabel(record) {
  if (!record) return "";
  const { w = 0, l = 0, t = 0 } = record;
  return t ? `${w}-${l}-${t}` : `${w}-${l}`;
}

/** "Sun 1:25 PM" in the viewer's own timezone. */
export function kickoffLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

/** "@PIT" -> {at:true, opp:"PIT"}; "CLE" -> {at:false, opp:"CLE"}. */
export function opponentOf(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const at = s.startsWith("@");
  return { at, opp: s.replace(/^@/, "") };
}

/**
 * The pairing edge: how much one side is currently worth over the other in
 * this slot.
 *
 * WORTH is actual points once the game is final, and the live projection
 * otherwise — a finished player is worth what he scored, not what he was
 * expected to score.
 *
 * This replaces the position pill that used to sit in the centre column. The
 * position was already printed under BOTH names, so the single most valuable
 * spot in the row — dead centre, between the two numbers being compared — was
 * spending itself on its third redundant copy.
 *
 * @returns {{delta:number, lead:"mine"|"theirs"|"even"}}
 */
export function pairingEdge(mineWorth, theirsWorth) {
  const a = Number.isFinite(mineWorth) ? mineWorth : 0;
  const b = Number.isFinite(theirsWorth) ? theirsWorth : 0;
  const delta = Math.round(Math.abs(a - b) * 10) / 10;
  // Under a point is noise, not an edge, and rendering "0.3 ◀" invites a
  // decision the number can't support.
  if (delta < 1) return { delta, lead: "even" };
  return { delta, lead: a > b ? "mine" : "theirs" };
}
