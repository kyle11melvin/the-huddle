// ============================================================================
// Countdown formatting.
//
// Lives in its own module rather than inside Today.jsx so the boundaries can
// be tested directly — 59m/60m, 23h59m/24h, and the day rollover are exactly
// where an off-by-one hides, and a component can't be imported by the plain
// node test harness.
// ============================================================================

/**
 * Milliseconds → "25d 11h 42m" / "11h 42m" / "42m" / "now".
 *
 * Units drop off as they stop mattering: at three weeks out nobody reads the
 * hours, and at ten minutes to kickoff the days would be noise.
 */
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** ISO timestamp → countdown string, or null once it's started. */
export function untilKick(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return formatCountdown(t - now);
}
