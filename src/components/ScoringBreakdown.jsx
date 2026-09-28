import { espnStatLabel } from "../data/espnStats.js";

/**
 * Why a player has the points he has — ESPN's per-category scoring for the
 * week, the same table ESPN's app shows when you tap a player mid-game.
 * Rows come straight from ESPN (api/espn.js scoringBreakdown), so they add
 * up to the number on the board; nothing here is re-scored.
 *
 * @param {{breakdown: Array<[number, number|null, number]>, actual: number}} entry
 * @param {string} status 'inProgress' | 'final' | anything else
 */
export default function ScoringBreakdown({ entry, status }) {
  if (!entry || !Array.isArray(entry.breakdown)) return null;
  const rows = entry.breakdown;
  // Before kickoff there is nothing to explain yet.
  if (!rows.length && status !== "inProgress" && status !== "final") return null;
  const total = Number.isFinite(entry.actual) ? entry.actual : rows.reduce((s, r) => s + r[2], 0);
  const tag = status === "final" ? "Final" : status === "inProgress" ? "Live" : null;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  return (
    <div className="sb">
      <div className="modal-section-label">
        Scoring breakdown{tag && <span className={`sb-tag ${tag === "Live" ? "live" : ""}`}>{tag}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="sb-empty">No scoring plays yet.</div>
      ) : (
        <table className="sb-table">
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">#</th>
              <th className="num">Pts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, n, pts]) => (
              <tr key={id}>
                <td>{espnStatLabel(id)}</td>
                <td className="num dim">{n == null ? "" : fmt(n)}</td>
                <td className={`num ${pts < 0 ? "neg" : ""}`}>{fmt(pts)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td />
              <td className="num">{fmt(Math.round(total * 10) / 10)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
