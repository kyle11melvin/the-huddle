// Move sheet, player detail, and add-player modals.
//
// Extracted verbatim from App.jsx (code-health step 4). Behaviour
// unchanged — this is a file move, pinned by the render smoke test.

import { useState, useEffect, useMemo } from "react";
import { teamOf, headshotUrl } from "../../data/teams.js";
import {
  legalDestinations, findLocation, rosterCounts, weekData, setWeekData,
  MAX_ROSTER, POS_LIMITS, POSITIONS, STATUSES, weekLabel,
} from "../../lineup.js";
import { effectiveStatus, isOnBye, byeWeekFor, ecrRank } from "../../analysis.js";
import { pointDistribution, playerAnalytics, floorCeiling } from "../../analytics.js";
import { scheduleOpp, nextOpponents } from "../../scheduleSync.js";
import { whoRosters, MY_TEAM } from "../../data/leagueRosters.js";
import { searchFreeAgents } from "../../data/freeAgents.js";
import Autocomplete from "../Autocomplete.jsx";
import { SLOT_COLOR, STATUS_LABEL, destKey, zoneLabel } from "../../constants.js";
import { Avatar, StatusPill, Stars, StarPicker, TeamChip, SectionHeader, EmptyState, initials } from "../ui/index.jsx";

export function MoveSheet({ state, playerId, onClose, onMove, coarse }) {
  const player = state.players[playerId];
  const dests = useMemo(() => (player ? legalDestinations(state, playerId) : []), [state, playerId, player]);
  // Escape closes on desktop; touch users get the backdrop and a full-width
  // Cancel button, because a 32px ✕ in the far corner is not a thumb target.
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!player) return null;
  const here = findLocation(state, playerId);

  return (
    <div className={`modal-backdrop ${coarse ? "to-bottom" : ""}`} onClick={onClose}>
      <div
        className={`modal sheet ${coarse ? "bottom-sheet" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${player.name}`}
      >
        {coarse && <div className="sheet-grabber" aria-hidden="true" />}
        <div className="sheet-head">
          <div>
            <div className="sheet-kicker">Move player</div>
            <div className="sheet-title">{player.name}</div>
            <div className="sheet-sub">
              {player.pos} · currently {here ? zoneLabel(here) : "—"}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-body">
          {dests.length === 0 && (
            <div className="sheet-none">
              No legal destinations right now. Free up a spot, or change this player's status.
            </div>
          )}
          {dests.map((d) => {
            const occ = d.occupantId ? state.players[d.occupantId] : null;
            return (
              <button key={destKey(d)} className="move-option" onClick={() => onMove(playerId, d)}>
                <span className="move-slot" style={{ background: SLOT_COLOR[zoneLabel(d)] || "var(--border-hi)" }}>
                  {zoneLabel(d)}
                </span>
                <span className="move-desc">
                  {occ ? (
                    <>
                      Swap with <strong>{occ.name}</strong>
                    </>
                  ) : (
                    <>Move to open {zoneLabel(d) === "BN" ? "bench" : zoneLabel(d)} spot</>
                  )}
                </span>
                <span className="move-arrow">→</span>
              </button>
            );
          })}
          {coarse && (
            <button className="sheet-cancel" onClick={onClose}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlayerModal({ state, playerId, week, onClose, onStatus, onWeek, onMoveOpen, onDrop, onEdit }) {
  const player = state.players[playerId];
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const [confirmDrop, setConfirmDrop] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState("");
  if (!player) return null;

  const team = teamOf(player.team);
  const loc = findLocation(state, playerId);
  const wd = weekData(player, week);
  const posColor = SLOT_COLOR[player.pos] || "var(--border-hi)";
  const byes = state.byes || {};
  const shownStatus = effectiveStatus(player, week, byes);
  const byeWk = byeWeekFor(byes, player.team);
  const owner = whoRosters(player.name);

  const startEdit = () => {
    setForm({ name: player.name, team: player.team, pos: player.pos, ecr: player.ecr || "", espnId: player.espnId || "" });
    setErr("");
    setEditing(true);
  };
  const saveEdit = () => {
    const res = onEdit(playerId, form);
    if (res?.error) setErr(res.error);
    else setEditing(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ "--team-ring": team.ring }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-hero">
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
          <Avatar player={player} />
          <div>
            <div className="modal-name">{player.name}</div>
            <div className="modal-sub">
              <span className="pos-chip" style={{ background: posColor }}>
                {player.pos}
              </span>
              <TeamChip abbr={player.team} />
              <StatusPill status={shownStatus} />
            </div>
          </div>
        </div>

        <div className="modal-body">
          <div className="modal-stat-grid">
            <div className="stat-tile">
              <div className="stat-label">ECR</div>
              <div className="stat-value" style={{ color: "var(--accent-bright)" }}>
                {player.ecr || "—"}
              </div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Slot</div>
              <div className="stat-value">{loc ? zoneLabel(loc) : "—"}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Bye</div>
              <div className="stat-value" style={{ color: byeWk ? "var(--gold)" : "var(--text-dim)" }}>
                {byeWk ? `WK ${byeWk}` : "—"}
              </div>
            </div>
          </div>

          {editing ? (
            <>
              <div className="modal-section-label">Edit details</div>
              <div className="edit-grid">
                <label className="field" style={{ gridColumn: "1 / -1" }}>
                  <span className="field-label">Name</span>
                  <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </label>
                <label className="field">
                  <span className="field-label">Team</span>
                  <input
                    value={form.team}
                    maxLength={4}
                    onChange={(e) => setForm((f) => ({ ...f, team: e.target.value.toUpperCase() }))}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Position</span>
                  <select value={form.pos} onChange={(e) => setForm((f) => ({ ...f, pos: e.target.value }))}>
                    {POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">ECR</span>
                  <input
                    value={form.ecr}
                    placeholder="RB6"
                    onChange={(e) => setForm((f) => ({ ...f, ecr: e.target.value }))}
                  />
                </label>
                <label className="field">
                  <span className="field-label">ESPN ID</span>
                  <input
                    value={form.espnId}
                    placeholder="4430807"
                    inputMode="numeric"
                    onChange={(e) => setForm((f) => ({ ...f, espnId: e.target.value }))}
                  />
                </label>
              </div>
              {err && <div className="form-error">{err}</div>}
              <div className="claim-actions" style={{ borderTop: "none", paddingTop: 12 }}>
                <button className="btn-primary" onClick={saveEdit}>
                  Save
                </button>
                <button className="btn-secondary" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="detail-strip">
              <span>
                Matchup {wd.matchup ? <Stars n={wd.matchup} /> : <em>not set</em>}
              </span>
              {owner && owner !== MY_TEAM && <span className="owner-tag">rostered by {owner}</span>}
              <button className="link-btn" onClick={startEdit}>
                Edit details
              </button>
            </div>
          )}

          <div className="modal-section-label">{weekLabel(week)} matchup</div>
          <div className="week-editor">
            <label className="field">
              <span className="field-label">Opponent</span>
              <input
                value={wd.opp}
                placeholder="e.g. CLE or @PIT"
                onChange={(e) => onWeek(playerId, { opp: e.target.value })}
              />
            </label>
            <div className="field">
              <span className="field-label">Matchup grade</span>
              <StarPicker value={wd.matchup} onChange={(n) => onWeek(playerId, { matchup: n })} />
            </div>
          </div>

          {player.notes && (
            <>
              <div className="modal-section-label">Scouting report</div>
              <div className="modal-scout">{player.notes}</div>
            </>
          )}

          <div className="modal-section-label">Status</div>
          <div className="status-editor">
            {STATUSES.map((tag) => {
              const active = player.status === tag;
              const danger = tag === "O" || tag === "IR";
              return (
                <button
                  key={tag || "active"}
                  className={`status-btn ${active ? "active" : ""} ${danger ? "danger" : ""}`}
                  onClick={() => onStatus(playerId, tag)}
                >
                  {STATUS_LABEL[tag] ?? tag}
                </button>
              );
            })}
          </div>

          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => onMoveOpen(playerId)}>
              ⇅ Move slot
            </button>
            {confirmDrop ? (
              <span className="confirm-row">
                <span className="confirm-text">Drop {player.name}?</span>
                <button className="btn-danger" onClick={() => onDrop(playerId)}>
                  Confirm
                </button>
                <button className="btn-secondary" onClick={() => setConfirmDrop(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button className="btn-danger-ghost" onClick={() => setConfirmDrop(true)}>
                Drop player
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AddPlayerModal({ state, onClose, onAdd }) {
  const [form, setForm] = useState({ name: "", team: "", pos: "", espnId: "" });
  const [err, setErr] = useState("");
  const { counts, total } = rosterCounts(state);

  const submit = () => {
    const res = onAdd(form);
    if (res?.error) setErr(res.error);
    else onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <div className="sheet-kicker">Free agent</div>
            <div className="sheet-title">Add to bench</div>
            <div className="sheet-sub">
              Roster {total}/{MAX_ROSTER} · {state.bench.filter((x) => !x).length} bench spot
              {state.bench.filter((x) => !x).length === 1 ? "" : "s"} open
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-body">
          <label className="field">
            <span className="field-label">Player</span>
            <Autocomplete
              value={form.name}
              onChange={(v) => {
                setForm((f) => ({ ...f, name: v }));
                setErr("");
              }}
              onPick={(item) => setForm((f) => ({ ...f, name: item.name, team: item.team, pos: item.pos }))}
              search={searchFreeAgents}
              placeholder="Start typing a name…"
            />
          </label>
          <div className="field-row">
            <label className="field" style={{ width: 110 }}>
              <span className="field-label">Team</span>
              <input
                value={form.team}
                placeholder="KC"
                maxLength={4}
                onChange={(e) => setForm((f) => ({ ...f, team: e.target.value.toUpperCase() }))}
              />
            </label>
            <label className="field" style={{ width: 120 }}>
              <span className="field-label">Position</span>
              <select value={form.pos} onChange={(e) => setForm((f) => ({ ...f, pos: e.target.value }))}>
                <option value="">—</option>
                {POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 1, minWidth: 130 }}>
              <span className="field-label">ESPN ID (optional)</span>
              <input
                value={form.espnId}
                placeholder="4360310"
                inputMode="numeric"
                onChange={(e) => setForm((f) => ({ ...f, espnId: e.target.value.trim() }))}
              />
            </label>
          </div>

          <div className="limit-grid">
            {POSITIONS.map((p) => {
              const used = counts[p] || 0;
              const max = POS_LIMITS[p];
              return (
                <span key={p} className={`limit-chip ${used >= max ? "full" : ""}`}>
                  {p} {used}/{max}
                </span>
              );
            })}
          </div>

          {err && <div className="form-error">{err}</div>}
          <button className="btn-primary" style={{ marginTop: 14 }} onClick={submit}>
            + Add to bench
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- claims ---

