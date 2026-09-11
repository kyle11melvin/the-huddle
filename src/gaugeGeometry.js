// ============================================================================
// Projection gauge geometry — pure, so it can be asserted on without
// rendering. Kept out of the component for the same reason analytics.js and
// lineup.js are: a render check proves a thing draws, not that it draws the
// RIGHT thing, and where the needle points is the whole claim the gauge makes.
// ============================================================================

/**
 * The dial is a FIXED 0-40, shared by every position.
 *
 * Deliberate and load-bearing: needle position carries meaning before any
 * number is read. On the real roster Bijan sits high on the dial and an RB4
 * near the floor. A per-player scale would flatten that to nothing — every
 * player identical, only the axis labels changing. 40 covers the highest real
 * ceiling (38.2). K and D/ST sitting low is honest.
 */
export const MAX = 40;

// Arc layout. A 224° sweep starting at 202° — wider than a half circle, so the
// ends drop below horizontal and the dial reads as an instrument face rather
// than a progress bar.
export const CX = 170;
export const CY = 164;
export const R = 130;
const A0 = 202;
const SWEEP = 224;

/** Value -> angle in degrees, clamped to the dial at both ends. */
export function angleFor(value, max = MAX) {
  const t = Math.max(0, Math.min(1, (value || 0) / max));
  return A0 - t * SWEEP;
}

/** Polar -> cartesian in SVG space (y grows downward, hence the minus). */
export function pointAt(value, radius, max = MAX) {
  const rad = (angleFor(value, max) * Math.PI) / 180;
  return [CX + radius * Math.cos(rad), CY - radius * Math.sin(rad)];
}

/**
 * How hot a tick burns, 0..1, by distance from the needle.
 *
 * The point is pre-attentive: the eye should land on the value before reading
 * a number. A flat band gives it nothing to land on.
 */
export function tickHeat(tickValue, needleValue, falloff = 9) {
  const d = Math.abs(tickValue - needleValue);
  return Math.max(0, 1 - d / falloff);
}

/**
 * Everything the gauge draws, as numbers.
 *
 * `mean`, `condMean` and `sd` come straight from pointDistribution() and are
 * NOT on one scale: `sd` describes the if-he-plays branch, so it belongs to
 * `condMean`, not to `mean`. The band is therefore condMean ∓ sd while the
 * needle sits at `mean` — and when playProb < 1 those pull apart, which is the
 * point rather than a defect. See docs/DESIGN.md.
 *
 * @returns {{floor:number, ceiling:number, needle:number, ghost:number|null,
 *            uncertain:boolean, needleOutsideBand:boolean}}
 */
export function gaugeGeometry({ mean, condMean, sd, playProb = 1 }) {
  const floor = Math.max(0, Math.round((condMean - sd) * 10) / 10);
  const ceiling = Math.round((condMean + sd) * 10) / 10;
  const uncertain = playProb < 1;
  return {
    floor,
    ceiling,
    needle: angleFor(mean),
    ghost: uncertain ? angleFor(condMean) : null,
    uncertain,
    needleOutsideBand: mean < floor || mean > ceiling,
  };
}
