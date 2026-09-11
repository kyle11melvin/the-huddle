// ============================================================================
// Projection gauge — the player card's hero.
//
// Per docs/DESIGN.md: floor left, ceiling right, needle at the projection,
// range drawn from the sd the blend already produces.
//
// THE ARC IS MADE OF LIGHT, NOT PAINT. Individual ticks radiate outward — gold
// and lit inside the floor..ceiling range, thin and recessive outside it — and
// they burn hotter the closer they sit to the needle. That last part is the
// whole trick: the eye lands on the value before consciously reading a number,
// which a solid painted band cannot do.
//
// THE SCALE IS FIXED (0-40) AND SHARED BY EVERY POSITION, so needle POSITION
// is meaningful before any number is read. K and D/ST sitting low is honest.
//
// THE NEEDLE CAN LAND OUTSIDE THE RANGE, and that is the most useful thing
// here: mean = condMean × playProb, so a TE at 14.9 if-he-plays with playProb
// 0.25 projects 3.7 — below his own floor. The ghost needle at condMean is
// what makes that legible rather than looking broken.
// ============================================================================

import { MAX, CX, CY, R, pointAt, tickHeat, gaugeGeometry } from "../gaugeGeometry.js";

const STEP = 0.5; // one tick per half point — 81 of them, fine enough to read as an instrument
const HERO_DY = -36;
const CAP_DY = -12;

function Ticks({ floor, ceiling, needle }) {
  const dim = [];
  const lit = [];
  const labels = [];

  for (let v = 0; v <= MAX + 1e-9; v += STEP) {
    const inRange = v >= floor && v <= ceiling;
    const major = Math.abs(v % 10) < 1e-3;
    const len = major ? (inRange ? 22 : 14) : inRange ? 17 : 9;
    const [x1, y1] = pointAt(v, R - len);
    const [x2, y2] = pointAt(v, R);

    if (inRange) {
      // Hotter toward the needle: brighter, wider, more opaque.
      const heat = tickHeat(v, needle);
      lit.push(
        <line
          key={v}
          x1={x1.toFixed(2)}
          y1={y1.toFixed(2)}
          x2={x2.toFixed(2)}
          y2={y2.toFixed(2)}
          className={heat > 0.55 ? "gg-tick-hot" : "gg-tick-lit"}
          strokeWidth={(2.6 + heat * 1.5).toFixed(2)}
          opacity={(0.62 + heat * 0.38).toFixed(3)}
          strokeLinecap="round"
        />
      );
    } else {
      dim.push(
        <line
          key={v}
          x1={x1.toFixed(2)}
          y1={y1.toFixed(2)}
          x2={x2.toFixed(2)}
          y2={y2.toFixed(2)}
          className="gg-tick-dim"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      );
    }

    if (major) {
      const [lx, ly] = pointAt(v, R - 28);
      labels.push(
        <text key={`l${v}`} x={lx.toFixed(2)} y={ly.toFixed(2)} className="gg-axis" textAnchor="middle" dominantBaseline="middle">
          {v.toFixed(0)}
        </text>
      );
    }
  }

  return (
    <>
      <g>{dim}</g>
      <g filter="url(#ggGlow)">{lit}</g>
      <g>{labels}</g>
    </>
  );
}

/** Full-length needle with a counterweight tail, anchored in a visible hub. */
function Needle({ value, ghost }) {
  const [tx, ty] = pointAt(value, R - 34);
  const [bx, by] = pointAt(value, -28); // negative radius = the tail, opposite the tip
  return (
    <line
      x1={bx.toFixed(2)}
      y1={by.toFixed(2)}
      x2={tx.toFixed(2)}
      y2={ty.toFixed(2)}
      className={ghost ? "gg-needle-ghost" : "gg-needle"}
      strokeLinecap="round"
    />
  );
}

/**
 * @param {number} mean      expected points — the headline, where the needle sits
 * @param {number} condMean  the if-he-plays branch
 * @param {number} sd        spread of the if-he-plays branch (describes condMean)
 * @param {number} playProb  1 when healthy; < 1 pulls mean below condMean
 * @param {number} show      value the dial is currently reading (tab selector)
 * @param {string} caption   label under the hero number
 */
export default function ProjectionGauge({ mean, condMean, sd, playProb = 1, show, caption = "PROJECTED" }) {
  const { floor, ceiling, uncertain } = gaugeGeometry({ mean, condMean, sd, playProb });
  const value = Number.isFinite(show) ? show : mean;

  return (
    <div className="gg">
      <svg
        className="gg-svg"
        viewBox="0 0 340 206"
        role="img"
        aria-label={`Projected ${mean} fantasy points. Floor ${floor}, ceiling ${ceiling}, on a 0 to ${MAX} scale.${
          uncertain ? ` ${condMean} if he plays, ${Math.round(playProb * 100)} percent likely.` : ""
        }`}
      >
        <defs>
          <filter id="ggGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="ggNeedleGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.2" result="n" />
            <feMerge>
              <feMergeNode in="n" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="ggHub" cx="50%" cy="50%" r="50%">
            <stop offset="0%" className="gg-hub-0" />
            <stop offset="55%" className="gg-hub-1" />
            <stop offset="100%" className="gg-hub-2" />
          </radialGradient>
        </defs>

        {/* warm light spilling from behind the dial */}
        <circle cx={CX} cy={CY} r={150} fill="url(#ggHub)" />

        <Ticks floor={floor} ceiling={ceiling} needle={value} />

        {/* floor and ceiling marked ON the arc — the visible range is the concept */}
        {[floor, ceiling].map((v) => {
          const [ax, ay] = pointAt(v, R - 27);
          const [bx, by] = pointAt(v, R + 11);
          return (
            <line
              key={`edge${v}`}
              x1={ax.toFixed(2)}
              y1={ay.toFixed(2)}
              x2={bx.toFixed(2)}
              y2={by.toFixed(2)}
              className="gg-edge"
              strokeLinecap="round"
            />
          );
        })}

        <g filter="url(#ggNeedleGlow)">
          {uncertain && <Needle value={condMean} ghost />}
          <Needle value={value} />
          <circle cx={CX} cy={CY} r={10} className="gg-hub-ring" />
          <circle cx={CX} cy={CY} r={2.8} className="gg-hub-dot" />
        </g>

        <text x={CX} y={CY + HERO_DY} textAnchor="middle" className="gg-hero">
          {value.toFixed(1)}
        </text>
        <text x={CX} y={CY + CAP_DY} textAnchor="middle" className="gg-cap">
          {caption}
        </text>
      </svg>

      {uncertain && (
        <div className="gg-ifplays">
          <span className="gg-ifplays-val">{condMean}</span> if he plays · {Math.round(playProb * 100)}%
        </div>
      )}

      <div className="gg-range">
        <div>
          <span className="gg-range-lab">Floor</span>
          <span className="gg-range-val">{floor}</span>
        </div>
        <div className="gg-range-r">
          <span className="gg-range-lab">Ceiling</span>
          <span className="gg-range-val">{ceiling}</span>
        </div>
      </div>
    </div>
  );
}
