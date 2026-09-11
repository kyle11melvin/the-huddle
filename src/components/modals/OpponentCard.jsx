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

  // The opponent's numbers come from ESPN's projection, not from our blend, so
  // there is no condMean/sd pair to draw a real range from. Derive the spread
  // from the position's coefficient of variation — the same constant the
  // simulator uses — rather than inventing one or drawing no range at all.
  const mean = Number.isFinite(row.proj) ? row.proj : null;
  const condMean = Number.isFinite(row.simProj) ? row.simProj : mean;
  const dist =
    mean == null
      ? null
      : {
          mean,
          condMean,
          sd: Math.round(condMean * (row.cv ?? 0.55) * 10) / 10,
          playProb: row.playProb ?? 1,
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
            // None of these exist for an opponent: props are priced for MY
            // roster only, and the matchup/consensus inputs are keyed on my
            // players. The card renders explicit no-data states rather than
            // borrowing numbers that were never computed for him.
            propsEdge={null}
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
              : "Opponent player — ESPN projection. Props, matchup and consensus are computed for your roster only."}
          </p>
        </div>
      </div>
    </div>
  );
}
