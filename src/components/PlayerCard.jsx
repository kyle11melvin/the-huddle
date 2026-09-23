// ============================================================================
// Player card — the screen you get when you tap into a player.
//
// The card is the EVIDENCE behind the projection, not just the projection.
// Order is weight order, per docs/DESIGN.md: the gauge is the headline, the
// props box sits directly beneath because it is the app's stated edge and
// should be the second thing seen, then matchup / consensus / book share a
// row, then news.
//
// One unit: where a value can be expressed in fantasy points it is, so the
// inputs can be compared and added. analysis.js already made that call for
// position need ("every value is in points, so a difference has one unit").
// Native units stay as the sub-label where they carry meaning points lose.
//
// Every tile degrades to an explicit no-data state rather than a confident
// zero. Props lines are absent for most players, the DvP model has almost no
// game logs in week 1, and the book spread isn't stored at all — so absent is
// the COMMON case, and a tile rendering 0.0 when it means "unknown" is
// actively misleading on a start/sit call.
// ============================================================================

import { useState } from "react";
import ProjectionGauge from "./ProjectionGauge.jsx";
import { gaugeGeometry } from "../gaugeGeometry.js";
import { teamOf, headshotUrl } from "../data/teams.js";

// Statuses meaning "may not take the field" — a season rank stops applying.
const DOUBTFUL = new Set(["D", "O", "IR"]);
const signed = (n) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

/** Shown when a headshot is missing or fails to load. */
function Silhouette() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="pc-silhouette">
      <circle cx="32" cy="20" r="13" />
      <path d="M6 64c0-14.4 11.6-24 26-24s26 9.6 26 24z" />
    </svg>
  );
}

/**
 * Circular headshot: gold hairline, dark spacer ring, and a wash of the
 * player's OWN team colour behind the cutout so he reads against the card
 * instead of floating on it. Driven by teams.js, never hardcoded.
 */
function Headshot({ player }) {
  const [failed, setFailed] = useState(false);
  const team = teamOf(player.team);
  const src = player.espnId ? headshotUrl(player.espnId) : null;
  return (
    <div className="pc-shot" style={{ "--team": (team && team.primary) || "#2A3B57" }}>
      {src && !failed ? (
        <img src={src} alt={player.name} onError={() => setFailed(true)} loading="lazy" />
      ) : (
        <Silhouette />
      )}
    </div>
  );
}

/** One of the three small tiles. `value` null renders the no-data state. */
function Tile({ label, value, sub, tone = "" }) {
  const missing = value === null || value === undefined;
  return (
    <div className={`pc-tile ${missing ? "pc-tile-empty" : ""}`}>
      <span className="pc-tile-k">{label}</span>
      <span className={`pc-tile-v ${tone}`}>{missing ? "—" : value}</span>
      <span className="pc-tile-sub">{missing ? "no data" : sub}</span>
    </div>
  );
}

/**
 * Semantic colour for the matchup read — the one sanctioned exception to
 * gold-only, because SMASH and BRUTAL rendered identically in gold defeats the
 * entire point. Recorded as an explicit carve-out in docs/DESIGN.md.
 */
const MATCHUP_TONE = {
  SMASH: "pc-grade-good",
  GOOD: "pc-grade-good",
  NEUTRAL: "",
  TOUGH: "pc-grade-bad",
  BRUTAL: "pc-grade-bad",
};

export default function PlayerCard({
  player,
  dist,
  propsEdge,
  // Whether the Vegas sweep ran for this week at all. Without it the card
  // cannot tell "the book has no line for him" from "nobody asked", and it
  // printed the first while meaning the second.
  propsSwept = true,
  source,
  matchup,
  consensus,
  book,
  news = [],
  // The modal renders its own hero, so the card drops its header there.
  showHeader = true,
}) {
  const { name, pos, team, opp, status } = player;
  const stale = consensus && consensus.stale != null ? consensus.stale : DOUBTFUL.has(status);

  // Projection / Floor / Ceiling — the same dial, read three ways.
  const [tab, setTab] = useState("PROJECTION");
  const g = dist ? gaugeGeometry(dist) : null;
  const values = g ? { PROJECTION: dist.mean, FLOOR: g.floor, CEILING: g.ceiling } : null;

  return (
    <div className="pc">
      {showHeader && (
        <div className="pc-head">
          <Headshot player={player} />
          <div className="pc-who">
            <div className="pc-name">{name}</div>
            <div className="pc-meta">
              <span className="pc-pos">{pos}</span>
              <span className="pc-dot">·</span>
              <span>{team}</span>
              {opp && <span className="pc-opp">{opp}</span>}
            </div>
          </div>
          {status && <div className={`pc-status pc-status-${status.toLowerCase()}`}>{status}</div>}
        </div>
      )}

      {dist ? (
        <>
          <ProjectionGauge {...dist} show={values[tab]} caption={tab === "PROJECTION" ? "PROJECTED" : tab} />
          <div className="pc-tabs">
            {["PROJECTION", "FLOOR", "CEILING"].map((k) => (
              <button key={k} type="button" className="pc-tab" aria-pressed={tab === k} onClick={() => setTab(k)}>
                <span>{k === "PROJECTION" ? "Projection" : k === "FLOOR" ? "Floor" : "Ceiling"}</span>
                <b>{values[k].toFixed(1)}</b>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="pc-nodist">No projection for this week</div>
      )}

      <div className={`pc-edge ${propsEdge ? "" : "pc-edge-empty"}`}>
        <div className="pc-edge-top">
          <span className="pc-edge-k">Vegas props</span>
          <span className="pc-edge-v">
            <b>{propsEdge ? signed(propsEdge.delta) : "—"}</b>
            <em>
              vs expert
              <br />
              consensus
            </em>
          </span>
        </div>
        <div className="pc-edge-line">
          {propsEdge
            ? propsEdge.parts.length
              ? propsEdge.parts.join("  ·  ")
              : "Market lines priced in"
            : propsSwept
              ? "No book lines for this player this week"
              : "Vegas lines haven't loaded for this week yet — sync ESPN to fetch them"}
        </div>
      </div>

      <div className="pc-three">
        {/* Was the matchup grade. It had no automatic source and read "no
            data" for nearly every player; this is computed for all of them. */}
        <Tile
          label="Source"
          value={source ? source.label : null}
          tone={source && source.edge ? "pc-src-edge" : ""}
          sub={source ? source.detail : ""}
        />
        <Tile
          label="Consensus"
          value={consensus ? consensus.rank : null}
          tone={consensus && stale ? "pc-stale" : ""}
          sub={
            consensus
              ? stale
                ? `season rank · stale (${status})`
                : `season · ${consensus.sources} source${consensus.sources === 1 ? "" : "s"}`
              : ""
          }
        />
        <Tile
          label="Book"
          value={book ? book.spread : null}
          // "imp 21" was the implied team total in shorthand nobody had
          // defined; say it: the points Vegas expects his team to score. Two
          // deliberate lines — one line wrapped and orphaned "pts".
          sub={
            book ? (
              book.total != null ? (
                <>
                  O/U {book.total}
                  <br />
                  {team} ~{book.implied} pts
                </>
              ) : (
                "implied team total"
              )
            ) : (
              ""
            )
          }
        />
      </div>

      {news.length > 0 && (
        <div className="pc-news">
          <span className="pc-news-k">Latest</span>
          {news.map((n, i) => (
            <div className="pc-item" key={i}>
              <time>{n.age}</time>
              <p>{n.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
