// ============================================================================
// Projection gauge geometry — pure, so it can be asserted on without
// rendering. Kept out of the component for the same reason analytics.js and
// lineup.js are: a render check proves a thing draws, not that it draws the
// right thing, and where the needle POINTS is the whole claim the gauge makes.
// ============================================================================

/**
 * The dial is a FIXED 0-40, shared by every position.
 *
 * That is deliberate and load-bearing: needle position carries meaning before
 * any number is read. On the real roster Bijan sits at 62% of the dial and an
 * RB4 at 9%. A per-player scale would flatten that to nothing — every player
 * would look identical with only the axis labels changing. 40 covers the
 * highest ceiling on a real roster (38.2). K and D/ST sitting low is honest.
 */
export const MAX = 40;

const START = 180; // left end of the arc, in degrees
const SWEEP = 180; // half circle

/** Value -> angle along the arc, clamped to the dial at both ends. */
export function angleFor(value, max = MAX) {
  const t = Math.max(0, Math.min(1, (value || 0) / max));
  return START + t * SWEEP;
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
