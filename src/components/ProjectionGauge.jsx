// ============================================================================
// Projection gauge — the player card's hero.
//
// Speedometer form, per docs/DESIGN.md: floor left, ceiling right, needle at
// the projection, range as an arc band from the sd the blend already produces.
//
// THE SCALE IS FIXED (0-40) AND SHARED BY EVERY POSITION. Needle POSITION
// carries meaning before any number is read: on the live roster Bijan sits at
// 62% of the dial and an RB4 at 9%. A per-player scale would flatten that to
// nothing. K and D/ST sitting low is honest, not a flaw.
//
// THE NEEDLE CAN LAND OUTSIDE THE BAND, and that is the most useful thing here:
// mean = condMean × playProb, so a TE at 14.9 if-he-plays with playProb 0.25
// projects 3.7 — below his own floor of 6.0. The ghost needle at condMean is
// what makes that legible rather than looking broken.
//
// GEOMETRY NOTE: the needle floats in the ring (r 64→86) instead of pivoting
// from the centre. A centre-pivoted needle crosses the hero number for any
// near-vertical value — it sliced straight through "24.7" in the first pass —
// and no amount of restyling fixes that, because the collision is structural.
// Floating it leaves the whole middle free for the readout.
// ============================================================================

import { MAX, angleFor, gaugeGeometry } from "../gaugeGeometry.js";

const CX = 110;
const CY = 116;
const R_TICK_OUT = 100; // outer edge of every tick
const R_TICK_IN = 88; // inner edge of a normal tick
const R_TICK_IN_BAND = 82; // in-band ticks run longer, so the range reads as mass
const R_NEEDLE_TIP = 86;
const R_NEEDLE_TAIL = 60;

const polar = (r, deg) => {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
};

function Tick({ value, inBand }) {
  const a = angleFor(value);
  const [x1, y1] = polar(inBand ? R_TICK_IN_BAND : R_TICK_IN, a);
  const [x2, y2] = polar(R_TICK_OUT, a);
  return <line x1={x1} y1={y1} x2={x2} y2={y2} className={inBand ? "gauge-tick-band" : "gauge-tick"} />;
}

/** Tapered pointer — wide at the tail, sharp at the tip. */
function Needle({ value, ghost }) {
  const a = angleFor(value);
  const [xTip, yTip] = polar(R_NEEDLE_TIP, a);
  const [xL, yL] = polar(R_NEEDLE_TAIL, a - 2.3);
  const [xR, yR] = polar(R_NEEDLE_TAIL, a + 2.3);
  return (
    <polygon
      points={`${xTip},${yTip} ${xL},${yL} ${xR},${yR}`}
      className={ghost ? "gauge-needle-ghost" : "gauge-needle"}
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

  // One tick per point. Fine graduations read as an instrument; the chunky
  // 2-point wedges of the first pass read as a progress bar.
  const ticks = [];
  for (let v = 0; v <= MAX; v += 1) {
    ticks.push(<Tick key={v} value={v} inBand={v >= floor && v <= ceiling} />);
  }

  return (
    <div className="gauge">
      <svg
        viewBox="0 0 220 140"
        className="gauge-svg"
        role="img"
        aria-label={`Projected ${mean} fantasy points. Range ${floor} to ${ceiling}.${
          uncertain ? ` ${condMean} if he plays, ${Math.round(playProb * 100)} percent likely.` : ""
        }`}
      >
        <g className="gauge-ticks">{ticks}</g>
        {/* Ghost first, so the real needle always draws over it. */}
        {uncertain && <Needle value={condMean} ghost />}
        <Needle value={mean} />

        <text x={6} y={136} className="gauge-axis">0</text>
        <text x={CX} y={12} className="gauge-axis gauge-axis-mid">20</text>
        <text x={214} y={136} className="gauge-axis gauge-axis-end">40</text>
      </svg>

      <div className="gauge-readout">
        <div className="gauge-hero">{mean}</div>
        <div className="gauge-hero-label">Projected</div>
        {uncertain && (
          <div className="gauge-ifplays">
            <span className="gauge-ifplays-val">{condMean}</span> if he plays ·{" "}
            {Math.round(playProb * 100)}%
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
