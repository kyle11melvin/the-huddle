// ============================================================================
// Client side of the ESPN write path. In-app lineup moves are REAL moves:
// they write through to ESPN (guardrails server-side), so a refresh can never
// revert them — the app and ESPN agree because they're the same roster.
// ============================================================================

// App zones → ESPN lineup slot ids (verified against the captured payload).
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, "D/ST": 16, K: 17, FLEX: 23 };
export const BENCH_SLOT = 20;
export const IR_SLOT = 21;

export function espnSlotId(loc) {
  if (!loc) return null;
  if (loc.zone === "bench") return BENCH_SLOT;
  if (loc.zone === "ir") return IR_SLOT;
  return SLOT_ID[loc.slotKey] ?? null;
}

/**
 * Write a move (and its swap partner, if any) to ESPN as one atomic
 * transaction. Items: [{espnId, from(loc), to(loc)}].
 * @returns {{ok:boolean, error?:string}}
 */
export async function writeLineupMove(state, moves) {
  const items = [];
  for (const m of moves) {
    const playerId = Number(m.espnId);
    const fromSlot = espnSlotId(m.from);
    const toSlot = espnSlotId(m.to);
    if (!Number.isFinite(playerId) || playerId <= 0) {
      return { ok: false, error: `${m.name || "A player"} has no ESPN id — sync first.` };
    }
    if (fromSlot == null || toSlot == null) return { ok: false, error: "Unmappable slot." };
    if (fromSlot === toSlot) continue; // same-position shuffle, ESPN doesn't care
    items.push({ playerId, fromSlot, toSlot });
  }
  if (!items.length) return { ok: true, noop: true };

  const base = import.meta.env.DEV ? "https://the-huddle-hq.vercel.app" : "";
  try {
    const r = await fetch(`${base}/api/espn-write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, scoringPeriodId: parseInt(state.week, 10) || undefined }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) return { ok: false, error: data.error || `Write failed (${r.status}).` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
}
