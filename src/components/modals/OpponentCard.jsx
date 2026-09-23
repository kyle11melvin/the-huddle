// ============================================================================
// Opponent player card.
//
// PlayerModal reads state.players[playerId] — which only ever holds MY roster.
// An opponent's players come off the ESPN snapshot and have no record there, so
// tapping one had nowhere to go. This is that destination: the same PlayerCard,
// fed from the Gameday row instead of from app state.
//
// Read-only by design. There is no status to set, no lineup slot to move, and
// nothing to drop — the actions on PlayerModal would all be lies here.
// ============================================================================

import { useEffect } from "react";
import PlayerCard from "../PlayerCard.jsx";
import { teamOf } from "../../data/teams.js";
import { fpProjFor, propsFor, propsSweptFor, blendProjection } from "../../analytics.js";

/**
 * @param {object} row a Gameday opponent row
 *   {name, pos, team, status, bye, proj, simProj, playProb, cv, espnId, estimated}
 */
export default function OpponentCard({ row, week, state, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!row) return null;

  // Which of the two sentences at the bottom is true for THIS player. The old
  // card told everyone "computed for your roster only" regardless, which is
  // now wrong for anyone the weekly paste covers.
  const fp = row.estimated ? null : fpProjFor(state, week, row.name);
  const book = row.estimated ? null : propsFor(state, week, row.name);
  const fpOnFile = !!fp;

  // Priced through blendProjection — the SAME call oppDist makes for the
  // simulation. The card used to build its own number straight off the row,
  // which was fine while the opponent was raw ESPN on both sides. It stopped
  // being fine the moment oppDist started blending: the note below would have
  // claimed "blended with your pasted FantasyPros projection" under a gauge
  // still showing ESPN's raw number. A card and the sim behind it disagreeing
  // is the exact split this whole group of fixes exists to close.
  const raw = Number.isFinite(row.simProj) ? row.simProj : Number.isFinite(row.proj) ? row.proj : null;
  const blend =
    raw == null || row.estimated
      ? null
      : blendProjection(
          { proj: raw, fpProj: fp ? fp.proj : null, propsProj: book ? book.proj : null, props: book ? book.props : null },
          row.pos,
          row.team,
          state
        );
  const condMean = blend ? Math.round(blend.mu * 10) / 10 : raw;
  const playProb = row.playProb ?? 1;
  const dist =
    condMean == null
      ? null
      : {
          mean: Math.round(condMean * playProb * 10) / 10,
          condMean,
          sd: blend
            ? Math.round(blend.sd * 10) / 10
            : Math.round(condMean * (row.cv ?? 0.55) * 10) / 10,
          playProb,
        };

  const team = teamOf(row.team);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ "--team-ring": team && team.ring }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body" style={{ paddingTop: 14 }}>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>

          <PlayerCard
            player={{
              name: row.name,
              pos: row.pos,
              team: row.team,
              opp: null,
              status: row.status || "",
              espnId: row.espnId || "",
            }}
            dist={dist}
            // The number IS the book's when a line exists, so the tile says
            // so and shows the edge over ESPN. What it cannot show is the
            // itemised legs: those are computed per player for my roster.
            // Leaving it as a bare null printed "No book lines for this
            // player this week" over a projection that came from exactly
            // those lines.
            propsEdge={
              book && Number.isFinite(raw)
                ? { delta: Math.round((book.proj - raw) * 10) / 10, parts: [], source: "odds-api" }
                : null
            }
            propsSwept={propsSweptFor(state, week)}
            matchup={null}
            consensus={null}
            book={
              state.espn && state.espn.impliedTotals && Number.isFinite(state.espn.impliedTotals[row.team])
                ? { spread: `${state.espn.impliedTotals[row.team]}`, total: null, implied: state.espn.impliedTotals[row.team] }
                : null
            }
            news={[]}
          />

          <p className="panel-note" style={{ marginTop: 14 }}>
            {row.estimated
              ? "Opponent player — projection estimated from expert rank, not an ESPN projection."
              : book
                ? "Opponent player — priced off the Vegas line, exactly as your own roster is. Money-backed lines outrank every expert projection on both sides of this matchup."
                : fpOnFile
                  ? "Opponent player — ESPN blended with your pasted FantasyPros projection, the same pricing your own roster gets. No book line for him this week."
                  : "Opponent player — ESPN projection only. No Vegas line and no pasted expert projection for him this week."}
          </p>
        </div>
      </div>
    </div>
  );
}
