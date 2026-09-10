// ============================================================================
// Projection gauge — the player card's hero.
//
// Speedometer form, per docs/DESIGN.md: floor left, ceiling right, needle at
// the projection, and the range drawn as an arc band from the sd the
// projection blend already produces.
//
// THE SCALE IS FIXED (0-40) AND SHARED BY EVERY POSITION. That is the whole
// point: needle POSITION carries meaning before you read a single number.
// On a real roster Bijan sits at 62% of the dial and a RB4 at 9%, and a
// per-player scale would flatten that difference to nothing — every player
// would look identical with only the axis labels changing. K and D/ST sitting
// low on this scale is honest, not a flaw.
//
// THE NEEDLE CAN LAND OUTSIDE THE BAND. This is a normal case, not an edge
// case, and it is the most useful thing the gauge draws:
//
//   mean = condMean × playProb
//
// so a tight end at 14.9 if-he-plays with playProb 0.25 projects 3.7 — below
// his own floor of 6.0. The solid needle sits left of the band, the ghost
// needle sits at condMean inside it, and the gap between them IS the start/sit
// decision, made spatial instead of arithmetic. Without the ghost that card
// just looks broken.
// ============================================================================

import { MAX, angleFor, gaugeGeometry } from "../gaugeGeometry.js";

const R_OUTER = 92;
const R_INNER = 74;
const CX = 110;
const CY = 110;

function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** Wedge between two angles, as an SVG path. */
function arcPath(a0, a1, rOuter, rInner) {
  const [x0o, y0o] = polar(CX, CY, rOuter, a0);
  const [x1o, y1o] = polar(CX, CY, rOuter, a1);
  const [x1i, y1i] = polar(CX, CY, rInner, a1);
  const [x0i, y0i] = polar(CX, CY, rInner, a0);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return [
    `M ${x0o} ${y0o}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o} ${y1o}`,
    `L ${x1i} ${y1i}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x0i} ${y0i}`,
    "Z",
  ].join(" ");
}

function Needle({ value, ghost }) {
  const a = angleFor(value);
  const [xTip, yTip] = polar(CX, CY, R_INNER - 4, a);
  const [xBase, yBase] = polar(CX, CY, 10, a);
  return (
    <line
      x1={xBase}
      y1={yBase}
      x2={xTip}
      y2={yTip}
      className={ghost ? "gauge-needle-ghost" : "gauge-needle"}
      strokeLinecap="round"
    />
  );
}

/**
 * @param {number} mean      expected points — the headline, where the needle sits
 * @param {number} condMean  the if-he-plays branch
 * @param {number} sd        spread of the if-he-plays branch (describes condMean)
 * @param {number} playProb  1 when healthy; < 1 pulls mean below condMean
 */
export default function ProjectionGauge({ mean, condMean, sd, playProb = 1 }) {
  const { floor, ceiling, uncertain } = gaugeGeometry({ mean, condMean, sd, playProb });

  // Ticks every 2 points, brightened inside the floor..ceiling band. Reading
  // the band as discrete ticks rather than a solid fill keeps it a speedometer
  // and makes the width countable at a glance.
  const ticks = [];
  for (let v = 0; v < MAX; v += 2) {
    const inBand = v >= floor && v <= ceiling;
    ticks.push(
      <path
        key={v}
        d={arcPath(angleFor(v) + 0.6, angleFor(v + 2) - 0.6, R_OUTER, R_INNER)}
        className={inBand ? "gauge-tick-band" : "gauge-tick"}
      />
    );
  }

  return (
    <div className="gauge">
      <svg
        viewBox="0 0 220 132"
        className="gauge-svg"
        role="img"
        aria-label={`Projected ${mean} points, range ${floor} to ${ceiling}`}
      >
        {ticks}
        {/* Ghost first so the solid needle always draws over it. */}
        {uncertain && <Needle value={condMean} ghost />}
        <Needle value={mean} />
        <circle cx={CX} cy={CY} r={6} className="gauge-hub" />
        <text x={16} y={126} className="gauge-axis">0</text>
        <text x={CX} y={14} className="gauge-axis gauge-axis-mid">20</text>
        <text x={204} y={126} className="gauge-axis gauge-axis-end">40</text>
      </svg>

      <div className="gauge-readout">
        <div className="gauge-hero">{mean}</div>
        <div className="gauge-hero-label">Fantasy points</div>
        {uncertain && (
          <div className="gauge-ifplays">
            {condMean} if he plays · {Math.round(playProb * 100)}%
          </div>
        )}
      </div>

      <div className="gauge-ends">
        <div className="gauge-end">
          <div className="gauge-end-label">Floor</div>
          <div className="gauge-end-value">{floor}</div>
        </div>
        <div className="gauge-end gauge-end-right">
          <div className="gauge-end-label">Ceiling</div>
          <div className="gauge-end-value">{ceiling}</div>
        </div>
      </div>
    </div>
  );
}
