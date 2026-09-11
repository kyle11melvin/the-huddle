// ============================================================================
// Player card — the screen you get when you tap into a player.
//
// The card is the EVIDENCE behind the projection, not just the projection.
// Order is weight order, per docs/DESIGN.md: the gauge is the headline, props
// take the full-width slot directly beneath it because they are the app's
// stated edge, and matchup / consensus / book share a row below that.
//
// One unit: where a value can be expressed in fantasy points it is, so the
// inputs can be compared and added. analysis.js already made that call for
// position need ("every value is in points, so a difference has one unit").
// Native units stay as the sub-label where they carry meaning a point value
// loses — a rank, a spread, a defensive ranking.
//
// Every tile degrades to an explicit "no data" rather than a confident zero.
// Props are pasted by hand today and the DvP model has almost no game logs in
// week 1, so absent data is the COMMON case, not the edge case, and a tile
// that renders 0.0 when it means "unknown" is actively misleading.
// ============================================================================

import ProjectionGauge from "./ProjectionGauge.jsx";

/** One of the three small tiles. `value` null renders the no-data state. */
function Tile({ label, value, sub, tone = "" }) {
  const missing = value === null || value === undefined;
  return (
    <div className={`pc-tile ${missing ? "pc-tile-empty" : ""}`}>
      <div className="pc-tile-label">{label}</div>
      <div className={`pc-tile-value ${tone}`}>{missing ? "—" : value}</div>
      <div className="pc-tile-sub">{missing ? "no data" : sub}</div>
    </div>
  );
}

const signed = (n) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

export default function PlayerCard({ player, dist, propsEdge, matchup, consensus, book, news = [] }) {
  const { name, pos, team, opp, status } = player;

  return (
    <div className="pc">
      <div className="pc-head">
        <div className="pc-ident">
          <h2 className="pc-name">{name}</h2>
          <div className="pc-meta">
            <span className="pc-pos">{pos}</span>
            <span className="pc-dot">·</span>
            <span>{team}</span>
            {opp && <span className="pc-opp">{opp}</span>}
          </div>
        </div>
        {status && <div className={`pc-status pc-status-${status.toLowerCase()}`}>{status}</div>}
      </div>

      <div className="pc-gauge">
        <ProjectionGauge {...dist} />
      </div>

      {/* Full width, and first: props are the edge, so they get the billing. */}
      <div className={`pc-edge ${propsEdge ? "" : "pc-edge-empty"}`}>
        <div className="pc-edge-top">
          <span className="pc-edge-label">Vegas props</span>
          <span className="pc-edge-value">{propsEdge ? signed(propsEdge.delta) : "—"}</span>
        </div>
        <div className="pc-edge-sub">
          {propsEdge ? propsEdge.parts.join("  ·  ") : "No lines pasted for this week"}
        </div>
      </div>

      <div className="pc-tiles">
        <Tile
          label="Matchup"
          value={matchup ? matchup.grade : null}
          sub={matchup ? `${signed(matchup.points)} pts · ${matchup.detail}` : ""}
        />
        <Tile
          label="Consensus"
          value={consensus ? consensus.rank : null}
          sub={consensus ? `${consensus.sources} sources · ±${consensus.spread}` : ""}
        />
        <Tile
          label="Book"
          value={book ? book.spread : null}
          sub={book ? `O/U ${book.total} · imp ${book.implied}` : ""}
        />
      </div>

      {news.length > 0 && (
        <div className="pc-news">
          <div className="pc-news-label">Latest</div>
          {news.map((n, i) => (
            <div className="pc-news-row" key={i}>
              <span className="pc-news-age">{n.age}</span>
              <span className="pc-news-text">{n.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
