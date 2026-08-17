import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { storage, HUDDLE_KEY } from "./storage.js";
import { teamOf, headshotUrl, teamLogoUrl } from "./data/teams.js";
import { searchFreeAgents, FREE_AGENTS } from "./data/freeAgents.js";
import {
  whoRosters,
  isVerifiedAvailable,
  verifiedTeam,
  MY_TEAM,
  LEAGUE_ROSTERS,
  VERIFIED_FREE_AGENTS,
} from "./data/leagueRosters.js";
import { CALL_TYPES } from "./data/seeds.js";
import Autocomplete from "./components/Autocomplete.jsx";
import DataPanel from "./components/DataPanel.jsx";
import LeagueBrowser from "./components/LeagueBrowser.jsx";
import StartSitLab from "./components/StartSitLab.jsx";
import { setPlayerAnalytics, playerAnalytics, pointDistribution } from "./analytics.js";
import { opponentDistributions } from "./simulate.js";
import { propsToPoints, leagueScoring } from "./props.js";
import { writeLineupMove } from "./espnWrite.js";
import {
  effectiveStatus,
  isOnBye,
  byeWeekFor,
  lineupWarnings,
  suggestLineup,
  myProfile,
  leagueStrength,
  tradeAngles,
  classifyAvailability,
  suggestAdds,
  ecrRank,
} from "./analysis.js";
import { readShareFromUrl, clearShareFromUrl } from "./share.js";
import {
  loadLink,
  saveLink,
  clearLink,
  newTeamId,
  newWriteKey,
  fetchTeam,
  pushTeam,
  createSyncer,
  readTeamCodeFromUrl,
  clearTeamCodeFromUrl,
  liveShareUrl,
} from "./remoteStore.js";
import {
  SLOT_DEFS,
  BENCH_SIZE,
  IR_SIZE,
  MAX_ROSTER,
  POS_LIMITS,
  POSITIONS,
  STATUSES,
  WEEKS,
  weekLabel,
  weekShort,
  buildInitialState,
  migrate,
  findLocation,
  legalDestinations,
  movePlayer,
  rosterCounts,
  addPlayer,
  dropPlayer,
  setStatus,
  weekData,
  setWeekData,
  applyWin,
  revertWin,
  editPlayer,
  addWatch,
  removeWatch,
  addCall,
  removeCall,
  setCallOutcome,
  callCalibration,
  toggleInterest,
  isInterested,
  setBye,
  mergeByes,
  setMatchupOpponent,
  setLiveEntry,
} from "./lineup.js";
import Gameday from "./components/Gameday.jsx";
import { fetchLeague, applyEspnSync, summaryToText, liveOwner, searchLeaguePlayers } from "./espnSync.js";
import {
  fetchSchedule,
  applySchedule,
  scheduleOpp,
  nextOpponents,
  byeCliffs,
  rosterCompetition,
  rosPoints,
  rosWeeks,
} from "./scheduleSync.js";
import { buildAlerts } from "./alerts.js";
import { watchIntel, sortWatchByIntel } from "./watchlist.js";

const SLOT_COLOR = {
  QB: "#ff5c6c",
  RB: "#2ed584",
  WR: "#5b8cff",
  TE: "#a78bfa",
  FLEX: "#8b93a1",
  "D/ST": "#8b93a1",
  K: "#8b93a1",
  BN: "#64708a",
  IR: "#c05a68",
};

const CALL_COLOR = { Start: "#2ed584", Sit: "#ff5c6c", Flex: "#5b8cff", Waiver: "#5b8cff", Trade: "#a78bfa" };
const STATUS_LABEL = { "": "ACTIVE", Q: "QUEST", D: "DOUBT", O: "OUT", IR: "IR", BYE: "BYE" };

const destKey = (d) => `${d.zone}:${d.slotKey || ""}:${d.index}`;
const zoneLabel = (d) => (d.zone === "lineup" ? d.slotKey : d.zone === "bench" ? "BN" : "IR");

function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ player, className = "" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [player.espnId, player.team]);
  const isLogo = !player.espnId;
  const src = player.espnId ? headshotUrl(player.espnId) : teamLogoUrl(player.team);
  const showImg = src && !failed;
  return (
    <div className={`avatar-ring ${className}`}>
      <div className="avatar-img">
        {showImg ? (
          <img
            src={src}
            alt={player.name}
            loading="lazy"
            className={isLogo ? "logo-img" : ""}
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="avatar-initials">{initials(player.name)}</span>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  if (!status) return null;
  const bg = status === "O" || status === "IR" ? "var(--negative)" : status === "BYE" ? "var(--text-dim)" : "#c99514";
  return (
    <span className="status-pill" style={{ background: bg }}>
      {status}
    </span>
  );
}

function Stars({ n }) {
  if (!n) return null;
  return (
    <div className="stars" aria-label={`Matchup grade ${n} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`star ${i <= n ? "lit" : ""}`}>
          ★
        </span>
      ))}
    </div>
  );
}

function StarPicker({ value, onChange }) {
  return (
    <div className="star-picker">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          className={`star ${i <= value ? "lit" : ""}`}
          onClick={() => onChange(i === value ? 0 : i)}
          aria-label={`Set matchup grade ${i}`}
        >
          ★
        </button>
      ))}
      {value > 0 && (
        <button type="button" className="star-clear" onClick={() => onChange(0)}>
          clear
        </button>
      )}
    </div>
  );
}

function TeamChip({ abbr }) {
  const t = teamOf(abbr);
  const logo = teamLogoUrl(abbr);
  if (!abbr) return null;
  return (
    <span className="team-chip" style={{ "--team-ring": t.ring }}>
      <span className="team-dot">{logo && <img src={logo} alt="" loading="lazy" />}</span>
      {abbr}
    </span>
  );
}

function SectionHeader({ kicker, title, count, action }) {
  return (
    <div className="section-head">
      {kicker && <div className="section-kicker">{kicker}</div>}
      <div className="section-title-row">
        <h2 className="section-title">{title}</h2>
        {typeof count === "number" && <span className="section-count">{String(count).padStart(2, "0")}</span>}
        {action && <span className="section-action">{action}</span>}
      </div>
    </div>
  );
}

function EmptyState({ title, icon = "↗", children }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <div>
        <div className="empty-title">{title}</div>
        <div className="empty-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- roster row ---

function RosterRow({
  dest,
  player,
  week,
  byes,
  oppFor,
  projFor,
  index,
  dragId,
  legalKeys,
  onOpen,
  onBadge,
  onDragStart,
  onDragEnd,
  onDrop,
}) {
  const [over, setOver] = useState(false);
  const label = zoneLabel(dest);
  const key = destKey(dest);
  const isLegalTarget = !!dragId && legalKeys.has(key);
  const isSource = dragId && player && dragId === player.id;

  const badgeColor = SLOT_COLOR[label] || "var(--border-hi)";
  const team = player ? teamOf(player.team) : null;
  const wd = player ? weekData(player, week) : null;
  const shownStatus = player ? effectiveStatus(player, week, byes) : "";
  const onBye = !!player && isOnBye(player, week, byes);
  // IR-flagged players may be flagged while still in a lineup slot; surface it.
  const illegalStart = !!player && dest.zone === "lineup" && player.status === "IR";
  const byeStarting = !!player && dest.zone === "lineup" && onBye;

  const handleDragOver = (e) => {
    if (!isLegalTarget) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!over) setOver(true);
  };

  if (!player) {
    return (
      <div
        className={`roster-row empty-slot ${isLegalTarget ? "legal" : ""} ${over ? "over" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onDrop(dest);
        }}
      >
        <span className="slot-tag" style={{ background: badgeColor }}>
          {label}
        </span>
        <span className="empty-slot-text">Empty {label === "BN" ? "bench spot" : label === "IR" ? "IR spot" : "slot"}</span>
      </div>
    );
  }

  return (
    <div
      className={`player-card ${isSource ? "dragging" : ""} ${isLegalTarget ? "legal" : ""} ${over ? "over" : ""} ${
        illegalStart || byeStarting ? "illegal-start" : ""
      }`}
      style={{ "--team-ring": team.ring, animationDelay: `${Math.min(index * 35, 350)}ms` }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", player.id);
        onDragStart(player.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop(dest);
      }}
      onClick={() => onOpen(player.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(player.id);
        }
      }}
    >
      <div className="player-main">
        <button
          type="button"
          className="slot-tag tappable"
          style={{ background: badgeColor }}
          title="Move player"
          onClick={(e) => {
            e.stopPropagation();
            onBadge(player.id);
          }}
        >
          {label}
          <span className="slot-tag-caret">⇅</span>
        </button>
        <Avatar player={player} />
        <div className="player-info">
          <div className="player-name-row">
            <span className="player-name">{player.name}</span>
            <StatusPill status={shownStatus} />
          </div>
          <div className="player-meta">
            <TeamChip abbr={player.team} />
            <span className="pos-mini">{player.pos}</span>
            {(wd.opp || (oppFor && oppFor(player))) && (
              <span>vs {wd.opp || oppFor(player)}</span>
            )}
          </div>
        </div>
        <div className="player-right">
          {projFor && projFor(player) != null && (
            <span className="row-proj" title="Projected points this week (props > ESPN, Vegas-tilted)">
              {projFor(player)}
            </span>
          )}
          <span className="ecr-badge">{player.ecr || "—"}</span>
          <Stars n={wd.matchup} />
        </div>
      </div>
      {illegalStart && (
        <div className="illegal-note">IR-flagged — move to an IR slot or the bench before kickoff.</div>
      )}
      {byeStarting && !illegalStart && (
        <div className="illegal-note">On bye this week — swap in someone who plays.</div>
      )}
      {player.notes && (
        <div className="scout-preview">
          <span className="scout-tag">SCOUT</span>
          <span className="scout-text">{player.notes}</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- modals ---

function MoveSheet({ state, playerId, onClose, onMove }) {
  const player = state.players[playerId];
  const dests = useMemo(() => (player ? legalDestinations(state, playerId) : []), [state, playerId, player]);
  if (!player) return null;
  const here = findLocation(state, playerId);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sheet" onClick={(e) => e.stopPropagation()}>
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
        </div>
      </div>
    </div>
  );
}

function PlayerModal({ state, playerId, week, onClose, onStatus, onWeek, onMoveOpen, onDrop, onEdit }) {
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

function AddPlayerModal({ state, onClose, onAdd }) {
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

function ClaimCard({ claim, state, onEdit, onResult, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => ({
    player: claim.player,
    team: claim.team || "",
    pos: claim.pos || "",
    espnId: claim.espnId || "",
    amount: String(claim.amount ?? ""),
    note: claim.note || "",
    dropName: claim.dropPlayerName || "",
    dropPlayerId: claim.dropPlayerId || "",
  }));
  const [err, setErr] = useState("");

  const rosterSearch = useCallback(
    (q, limit) => {
      const s = q.trim().toLowerCase();
      if (!s) return [];
      return Object.values(state.players)
        .filter((p) => p.name.toLowerCase().includes(s))
        .slice(0, limit)
        .map((p) => ({ name: p.name, team: p.team, pos: p.pos, id: p.id }));
    },
    [state.players]
  );

  const save = () => {
    const res = onEdit(claim.id, form);
    if (res?.error) setErr(res.error);
    else setEditing(false);
  };

  if (editing) {
    return (
      <div className="card claim-edit">
        <div className="claim-edit-head">Edit claim</div>
        <label className="field">
          <span className="field-label">Player to add</span>
          <Autocomplete
            value={form.player}
            onChange={(v) => setForm((f) => ({ ...f, player: v }))}
            onPick={(item) => setForm((f) => ({ ...f, player: item.name, team: item.team, pos: item.pos }))}
            search={searchFreeAgents}
            placeholder="Player name"
          />
        </label>
        <div className="field-row">
          <label className="field" style={{ width: 100 }}>
            <span className="field-label">Team</span>
            <input value={form.team} maxLength={4} onChange={(e) => setForm((f) => ({ ...f, team: e.target.value.toUpperCase() }))} />
          </label>
          <label className="field" style={{ width: 110 }}>
            <span className="field-label">Pos</span>
            <select value={form.pos} onChange={(e) => setForm((f) => ({ ...f, pos: e.target.value }))}>
              <option value="">—</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ width: 100 }}>
            <span className="field-label">$ Bid</span>
            <input value={form.amount} inputMode="numeric" onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
          </label>
        </div>
        <label className="field">
          <span className="field-label">Player to drop</span>
          <Autocomplete
            value={form.dropName}
            onChange={(v) => setForm((f) => ({ ...f, dropName: v, dropPlayerId: "" }))}
            onPick={(item) => setForm((f) => ({ ...f, dropName: item.name, dropPlayerId: item.id }))}
            search={rosterSearch}
            placeholder="From your roster (optional)"
          />
        </label>
        <label className="field">
          <span className="field-label">Note</span>
          <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="claim-actions" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={save}>
            Save
          </button>
          <button className="btn-secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card claim-card-full">
      <div className="claim-row">
        <div style={{ minWidth: 0 }}>
          <div className="claim-name">
            {claim.player}
            <span className="claim-amount">${claim.amount}</span>
          </div>
          <div className="claim-sub">
            {claim.pos && <span className="pos-mini">{claim.pos}</span>}
            {claim.team && <TeamChip abbr={claim.team} />}
            {claim.dropPlayerName && <span className="drop-note">drop {claim.dropPlayerName}</span>}
            {claim.lostTo && <span className="drop-note">outbid — landed on {claim.lostTo}</span>}
            {claim.autoResolved && <span className="pos-mini">auto-detected</span>}
          </div>
          {claim.note && <div className="claim-note">{claim.note}</div>}
        </div>
        <span className={`result-pill ${claim.result === "Won" ? "won" : claim.result === "Lost" ? "lost" : "pending"}`}>
          {claim.result}
        </span>
      </div>
      <div className="claim-actions">
        <button className="chip-btn" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          className={`chip-btn ${claim.result === "Won" ? "on-win" : ""}`}
          onClick={() => onResult(claim.id, claim.result === "Won" ? "Pending" : "Won")}
        >
          {claim.result === "Won" ? "Un-win" : "Mark Won"}
        </button>
        <button
          className={`chip-btn ${claim.result === "Lost" ? "on-loss" : ""}`}
          onClick={() => onResult(claim.id, claim.result === "Lost" ? "Pending" : "Lost")}
        >
          {claim.result === "Lost" ? "Un-lose" : "Mark Lost"}
        </button>
        <button className="chip-btn danger" onClick={() => onDelete(claim.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * Global player search — the "who owns this guy" box. One shared engine
 * (searchLeaguePlayers) across all 10 rosters + the free-agent pool, so a
 * name from an injury blurb resolves instantly instead of requiring a tour
 * of every roster in the league browser.
 */
function PlayerSearchPanel({ state, onToggleInterest }) {
  const [q, setQ] = useState("");
  const results = useMemo(() => searchLeaguePlayers(state, q, 8), [state, q]);

  return (
    <div className="card psearch">
      <div className="psearch-bar">
        <span className="psearch-icon" aria-hidden="true">⌕</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find any player — see who owns them…"
          autoComplete="off"
          spellCheck="false"
          aria-label="Search all league players"
        />
        {q && (
          <button className="psearch-clear" onClick={() => setQ("")} aria-label="Clear search">
            ✕
          </button>
        )}
      </div>
      {q.trim().length >= 2 && results.length === 0 && (
        <div className="psearch-empty">
          No match in the league pool. If they're a deep stash, add them by name from the Watchlist tab.
        </div>
      )}
      {results.length > 0 && (
        <div className="psearch-results">
          {results.map((r) => {
            const starred = isInterested(state, r.name);
            return (
              <div key={`${r.name}-${r.team}`} className="psearch-row">
                <span className="pos-chip" style={{ background: SLOT_COLOR[r.pos] || "var(--border-hi)" }}>
                  {r.pos}
                </span>
                <span className="psearch-name">
                  {r.name}
                  {r.proj != null && <span className="psearch-proj">{r.proj} proj</span>}
                </span>
                <TeamChip abbr={r.team} />
                <span className={`own-chip ${r.mine ? "mine" : r.owner ? "taken" : "free"}`}>
                  {r.mine ? "YOUR ROSTER" : r.owner ? `Owned by ${r.owner}` : "FREE AGENT"}
                </span>
                {!r.mine && (
                  <button
                    className={`star-btn ${starred ? "on" : ""}`}
                    title={
                      starred
                        ? "On your watchlist — click to remove"
                        : r.owner
                        ? "Track as a trade target (rostered — not claimable)"
                        : "Track on your watchlist"
                    }
                    onClick={() => onToggleInterest({ name: r.name, team: r.team, pos: r.pos })}
                  >
                    {starred ? "★" : "☆"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WatchForm({ onAdd, onDone, search }) {
  const [form, setForm] = useState({ name: "", team: "", note: "" });
  const [err, setErr] = useState("");
  const submit = () => {
    const res = onAdd(form);
    if (res?.error) setErr(res.error);
    else {
      setForm({ name: "", team: "", note: "" });
      onDone();
    }
  };
  return (
    <div className="card">
      <label className="field">
        <span className="field-label">Player</span>
        <Autocomplete
          value={form.name}
          onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          onPick={(item) => setForm((f) => ({ ...f, name: item.name, team: item.team }))}
          search={search || searchFreeAgents}
          placeholder="Any player — rostered ones show their owner"
        />
      </label>
      <div className="field-row">
        <label className="field" style={{ width: 110 }}>
          <span className="field-label">Team</span>
          <input
            value={form.team}
            maxLength={4}
            onChange={(e) => setForm((f) => ({ ...f, team: e.target.value.toUpperCase() }))}
          />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          <span className="field-label">Why you're watching</span>
          <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </label>
      </div>
      {err && <div className="form-error">{err}</div>}
      <button className="btn-primary" style={{ marginTop: 12 }} onClick={submit}>
        + Add to watch
      </button>
    </div>
  );
}

function CallForm({ state, week, onAdd }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ player: "", type: "Start", reasoning: "", confidence: 3 });
  const [err, setErr] = useState("");

  const rosterSearch = useCallback(
    (q, limit) => {
      const s = q.trim().toLowerCase();
      if (!s) return [];
      return Object.values(state.players)
        .filter((p) => p.name.toLowerCase().includes(s))
        .slice(0, limit)
        .map((p) => ({ name: p.name, team: p.team, pos: p.pos }));
    },
    [state.players]
  );

  if (!open) {
    return (
      <button className="log-cta" onClick={() => setOpen(true)}>
        + Log a call for {weekLabel(week)}
      </button>
    );
  }

  const submit = () => {
    const res = onAdd({ ...form, week });
    if (res?.error) setErr(res.error);
    else {
      setForm({ player: "", type: "Start", reasoning: "", confidence: 3 });
      setOpen(false);
    }
  };

  return (
    <div className="card">
      <div className="claim-edit-head">New call · {weekLabel(week)}</div>
      <label className="field">
        <span className="field-label">Player</span>
        <Autocomplete
          value={form.player}
          onChange={(v) => setForm((f) => ({ ...f, player: v }))}
          onPick={(item) => setForm((f) => ({ ...f, player: item.name }))}
          search={rosterSearch}
          placeholder="Who was the call about?"
        />
      </label>
      <div className="field-row">
        <label className="field" style={{ width: 130 }}>
          <span className="field-label">Type</span>
          <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
            {CALL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <div className="field" style={{ flex: 1, minWidth: 170 }}>
          <span className="field-label">How sure are you?</span>
          <div className="conf-picker">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`conf-dot ${n <= form.confidence ? "on" : ""}`}
                onClick={() => setForm((f) => ({ ...f, confidence: n }))}
                aria-label={`Confidence ${n}`}
              />
            ))}
          </div>
        </div>
      </div>
      <label className="field">
        <span className="field-label">Reasoning</span>
        <textarea
          rows={3}
          value={form.reasoning}
          onChange={(e) => setForm((f) => ({ ...f, reasoning: e.target.value }))}
          placeholder="Why you made this call — the part you'll want back in week 12."
        />
      </label>
      {err && <div className="form-error">{err}</div>}
      <div className="claim-actions" style={{ borderTop: "none", paddingTop: 12 }}>
        <button className="btn-primary" onClick={submit}>
          Save call
        </button>
        <button className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ lineup check ---

function LineupCheck({ state, week, onApply, onApplyAll }) {
  const warnings = useMemo(() => lineupWarnings(state, week), [state, week]);
  // With this week's opponent known, suggestions rank by WIN PROBABILITY —
  // the optimizer executes the ceiling/floor strategy, not just raw points.
  const oppDists = useMemo(() => opponentDistributions(state, week), [state, week]);
  const moves = useMemo(() => suggestLineup(state, week, oppDists), [state, week, oppDists]);
  const errors = warnings.filter((w) => w.level === "error");
  const soft = warnings.filter((w) => w.level !== "error");
  const winMode = oppDists.length > 0;

  if (!errors.length && !moves.length) {
    return (
      <div className="check-card clean">
        <span className="check-icon ok">✓</span>
        <div>
          <div className="check-title">Lineup looks optimal</div>
          <div className="check-sub">
            {winMode
              ? `No available swap improves your win probability this week — checked every bench player against your actual matchup.`
              : `Nobody out or on bye, and no bench player outranks a starter for ${weekLabel(week)}.`}
            {soft.length > 0 && ` ${soft.length} minor note${soft.length === 1 ? "" : "s"}.`}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`check-card ${errors.length ? "bad" : "warn"}`}>
      <div className="check-head">
        <span className={`check-icon ${errors.length ? "bad" : "warn"}`}>{errors.length ? "!" : "~"}</span>
        <div>
          <div className="check-title">
            {errors.length ? `${errors.length} problem${errors.length === 1 ? "" : "s"} in your lineup` : "Lineup suggestions"}
          </div>
          <div className="check-sub">{weekLabel(week)}</div>
        </div>
        {moves.length > 1 && (
          <button className="mini-btn" onClick={onApplyAll}>
            Apply all {moves.length}
          </button>
        )}
      </div>

      {errors.length > 0 && (
        <ul className="check-list">
          {errors.map((w, i) => (
            <li key={i}>
              <span className="check-slot">{w.slot}</span>
              {w.text}
            </li>
          ))}
        </ul>
      )}

      {moves.map((m) => (
        <div key={`${m.slotKey}:${m.index}`} className="move-suggest">
          <span className="move-slot" style={{ background: SLOT_COLOR[m.slotKey] || "var(--border-hi)" }}>
            {m.slotKey}
          </span>
          <span className="move-suggest-text">
            Start <strong>{m.inName}</strong>
            {m.outName ? (
              <>
                {" "}
                over <span className="out-name">{m.outName}</span>
              </>
            ) : null}
            <span className="move-reason"> — {m.reason}</span>
          </span>
          <button className="chip-btn" onClick={() => onApply(m)}>
            Apply
          </button>
        </div>
      ))}

      {soft.length > 0 && (
        <div className="check-soft">
          {soft.map((w, i) => (
            <span key={i}>{w.text}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- strength ---

function StrengthCard({ state, onOpenData }) {
  const strength = useMemo(() => leagueStrength(state), [state]);
  const angles = useMemo(() => tradeAngles(state), [state]);
  const profile = useMemo(() => myProfile(state), [state]);

  if (!strength.ready) {
    return (
      <div className="card strength-card">
        <div className="strength-head">
          <div>
            <div className="section-kicker">Positional profile</div>
            <div className="strength-title">Your roster by ECR</div>
          </div>
        </div>
        <div className="profile-rows">
          {POSITIONS.filter((p) => profile[p]?.length).map((pos) => (
            <div key={pos} className="profile-row">
              <span className="pos-chip" style={{ background: SLOT_COLOR[pos] || "var(--border-hi)" }}>
                {pos}
              </span>
              <span className="profile-ranks">
                {profile[pos].map((x, i) => (
                  <span key={i} className="profile-rank" title={x.name}>
                    {x.rank ?? "—"}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        <div className="strength-hint">
          League-wide ranking needs ECR for other teams' players too —{" "}
          <button className="link-btn" onClick={onOpenData}>
            paste a ranking set
          </button>{" "}
          to unlock it. Covered {Math.round((strength.coverage || 0) * 100)}% of {strength.total || 0} opponent
          players so far.
        </div>
      </div>
    );
  }

  return (
    <div className="card strength-card">
      <div className="strength-head">
        <div>
          <div className="section-kicker">vs the league</div>
          <div className="strength-title">Positional strength</div>
        </div>
        <span className="coverage-chip">{Math.round(strength.coverage * 100)}% ranked</span>
      </div>
      <div className="strength-bars">
        {POSITIONS.map((pos) => {
          const r = strength.ranks[pos];
          const pct = ((r.of - r.rank) / (r.of - 1)) * 100;
          const tone = r.rank <= 3 ? "good" : r.rank >= Math.ceil(r.of * 0.7) ? "bad" : "mid";
          return (
            <div key={pos} className="strength-row">
              <span className="strength-pos">{pos}</span>
              <div className="strength-track">
                <div className={`strength-fill ${tone}`} style={{ width: `${Math.max(4, pct)}%` }} />
              </div>
              <span className={`strength-rank ${tone}`}>
                {r.rank}
                <span className="of">/{r.of}</span>
              </span>
            </div>
          );
        })}
      </div>
      {angles.ready && angles.partners.length > 0 && (
        <>
          <div className="modal-section-label">Trade angles</div>
          <div className="angle-list">
            {angles.partners.slice(0, 4).map((p) => (
              <div key={p.team} className="angle-row">
                <span className="angle-team">{p.team}</span>
                <span className="angle-body">
                  send <strong className="give">{p.give.join("/")}</strong> · get{" "}
                  <strong className="get">{p.get.join("/")}</strong>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------- app ---

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [tab, setTab] = useState("roster");
  const [state, setState] = useState(buildInitialState);
  const [notice, setNotice] = useState("");
  const [modalId, setModalId] = useState(null);
  const [moveId, setMoveId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [interestFilter, setInterestFilter] = useState("all");
  const [viewingShared, setViewingShared] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [link, setLink] = useState(null); // live-sync identity, if any
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncError, setSyncError] = useState("");
  const [claimForm, setClaimForm] = useState({
    player: "",
    team: "",
    pos: "",
    amount: "",
    result: "Pending",
    note: "",
    dropName: "",
    dropPlayerId: "",
  });
  const noticeTimer = useRef(null);

  const flash = useCallback((msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 3200);
  }, []);

  const syncer = useRef(null);
  if (!syncer.current) {
    syncer.current = createSyncer((status, detail) => {
      setSyncStatus(status);
      setSyncError(status === "error" ? detail || "Sync failed" : "");
    });
  }

  useEffect(() => {
    (async () => {
      const readLocal = async () => {
        try {
          const res = await storage.get(HUDDLE_KEY);
          if (res && res.value) setState(migrate(JSON.parse(res.value)));
        } catch (e) {
          // no saved data yet — seeds stand
        }
      };

      // 1. ?team=CODE — a live team, freshest source there is.
      const code = readTeamCodeFromUrl();
      const saved = loadLink();
      if (code) {
        clearTeamCodeFromUrl();
        try {
          const res = await fetchTeam(code);
          if (!res.notFound) {
            setState(migrate(res.state));
            // Opening your own code on a new device keeps ownership.
            const mine = saved && saved.id === code && saved.key;
            const nextLink = mine ? saved : { id: code, mode: "viewer" };
            setLink(nextLink);
            saveLink(nextLink);
            setViewingShared(!mine);
            setLoaded(true);
            return;
          }
          setSyncError("That team code doesn't exist (yet).");
        } catch (e) {
          setSyncError(e.message);
        }
      }

      // 2. A team we're already linked to.
      if (saved && saved.id) {
        setLink(saved);
        try {
          const res = await fetchTeam(saved.id);
          if (!res.notFound) {
            setState(migrate(res.state));
            setViewingShared(saved.mode !== "owner");
            setLoaded(true);
            return;
          }
          // The published team no longer exists — following it forever would
          // trap the user on a dead snapshot. Unlink and fall back to local.
          clearLink();
          setLink(null);
        } catch (e) {
          setSyncError(`${e.message} — showing your local copy.`);
        }
      }

      // 3. Legacy #team= snapshot link.
      const shared = readShareFromUrl();
      if (shared) {
        setState(migrate(shared));
        setViewingShared(true);
        clearShareFromUrl();
        setLoaded(true);
        return;
      }

      // 4. Local only.
      await readLocal();
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        const res = await storage.set(HUDDLE_KEY, JSON.stringify(state));
        setSaveError(!res);
      } catch (e) {
        setSaveError(true);
      }
    })();
    // Mirror to the server only when we own the team. Debounced inside.
    if (link && link.mode === "owner" && link.key) {
      syncer.current.queue(link.id, link.key, state);
    }
  }, [loaded, state, link]);

  // Viewers pull the owner's changes: on tab re-focus, and on a slow poll so a
  // page left open in the foreground still updates. ~45s across a 10-person
  // league is a rounding error against the free tier.
  useEffect(() => {
    if (!link || link.mode !== "viewer") return;
    let stopped = false;
    const refresh = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const res = await fetchTeam(link.id);
        if (stopped) return;
        if (res.notFound) {
          // Followed team was unpublished — release the user instead of
          // silently pinning them to a stale copy.
          clearLink();
          setLink(null);
          setViewingShared(false);
          flash("That shared team is no longer published — back to your own.");
          return;
        }
        setState(migrate(res.state));
      } catch {
        /* stay on the local copy */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const poll = setInterval(refresh, 45000);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(poll);
    };
  }, [link, flash]);

  const week = state.week;
  const { counts, total, irUsed } = useMemo(() => rosterCounts(state), [state]);
  const calibration = useMemo(() => callCalibration(state.calls), [state.calls]);

  /** Ownership from the live ESPN snapshot when we have one, else the static transcription. */
  const ownerOf = useCallback(
    (name) => (state.espn ? liveOwner(state, name) : whoRosters(name)),
    [state]
  );

  const interestCounts = useMemo(() => {
    const list = state.watch || [];
    const taken = list.filter((w) => ownerOf(w.name)).length;
    return { all: list.length, taken, free: list.length - taken };
  }, [state.watch, ownerOf]);

  const watchIntelById = useMemo(() => {
    const out = {};
    for (const w of state.watch || []) {
      out[w.id] = watchIntel(state, w, ownerOf(w.name));
    }
    return out;
  }, [state, ownerOf]);

  const filteredInterest = useMemo(() => {
    const list = state.watch || [];
    const subset =
      interestFilter === "free"
        ? list.filter((w) => !ownerOf(w.name))
        : interestFilter === "taken"
        ? list.filter((w) => ownerOf(w.name))
        : list;
    return sortWatchByIntel(subset, watchIntelById);
  }, [state.watch, interestFilter, ownerOf, watchIntelById]);

  const legalKeys = useMemo(() => {
    if (!dragId) return new Set();
    return new Set(legalDestinations(state, dragId).map(destKey));
  }, [dragId, state]);

  /** Best genuinely-unrostered players. Ranked once an ECR index exists;
   *  before that, falls back to the ESPN-verified free agents. */
  /** Auto ranks from ESPN projections, with pasted expert ranks winning on conflict. */
  const mergedIndex = useMemo(
    () => ({ ...((state.espn && state.espn.autoRanks) || {}), ...(state.ecrIndex || {}) }),
    [state]
  );

  const availablePool = useMemo(() => {
    const key = (s) => s.toLowerCase().replace(/[^a-z]/g, "");

    // Live ESPN pool: the actual FA list for THIS league, with projections.
    // No pasting, no static file, no staleness.
    if (state.espn && state.espn.pool && state.espn.pool.length) {
      const mine = new Set(Object.values(state.players).map((p) => key(p.name)));
      return state.espn.pool
        // p.team filters out unsigned NFL free agents — ESPN still projects
        // them, but a player with no team can't score points this week.
        .filter((p) => p.onTeamId === 0 && p.team && !mine.has(key(p.name)) && p.proj > 0)
        .map((p) => ({ name: p.name, team: p.team, pos: p.pos, rank: mergedIndex[key(p.name)] ?? null, proj: p.proj }))
        .filter((p) => p.rank != null)
        .sort((a, b) => a.rank - b.rank);
    }

    const index = mergedIndex;
    const hasIndex = Object.keys(index).length > 0;
    // The generated pool skips league-wide locked-in starters — but in a
    // 10-team league, star players genuinely sit on the wire (ESPN showed
    // Mahomes as an FA). Merge in what ESPN actually listed as available.
    const seen = new Set(FREE_AGENTS.map((p) => key(p.name)));
    const candidates = [
      ...FREE_AGENTS,
      ...VERIFIED_FREE_AGENTS.filter(([n]) => !seen.has(key(n))).map(([name, team, pos]) => ({ name, team, pos })),
    ];
    let available;
    if (state.espn) {
      // Live truth: available = on nobody's roster in the latest ESPN snapshot.
      const mine = new Set(Object.values(state.players).map((p) => key(p.name)));
      available = candidates.filter((c) => !mine.has(key(c.name)) && liveOwner(state, c.name) == null);
    } else {
      ({ available } = classifyAvailability(candidates, state));
    }
    const scored = available
      // ESPN is the source of truth for team when it listed the player
      .map((p) => ({ ...p, team: verifiedTeam(p.name) || p.team, rank: index[key(p.name)] ?? null }))
      .filter((p) => (hasIndex ? p.rank != null : isVerifiedAvailable(p.name)));
    scored.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999) || a.name.localeCompare(b.name));
    return scored;
  }, [state, mergedIndex]);

  const topAvailable = useMemo(() => availablePool.slice(0, 15), [availablePool]);
  const suggestions = useMemo(() => suggestAdds(state, availablePool), [state, availablePool]);
  const cliffs = useMemo(() => byeCliffs(state), [state]);

  /** Weakest same-position player on my roster — the natural drop for a pickup. */
  const dropCandidateFor = useCallback(
    (pos) => {
      let worst = null;
      for (const p of Object.values(state.players)) {
        if (p.pos !== pos) continue;
        const proj = playerAnalytics(state, p.id, week)?.proj ?? 0;
        if (!worst || proj < worst.proj) worst = { p, proj };
      }
      return worst;
    },
    [state, week]
  );
  const alerts = useMemo(() => buildAlerts(state), [state]);
  const dismissAlert = useCallback(
    (id) =>
      setState((s) => ({
        ...s,
        alertsDismissed: { ...(s.alertsDismissed || {}), [id]: Date.now() },
      })),
    []
  );

  /** Resolve a free-typed drop name to a roster player id when it matches. */
  const resolveDropId = useCallback(
    (id, name) => {
      if (id && state.players[id]) return id;
      const n = (name || "").trim().toLowerCase();
      if (!n) return "";
      const hit = Object.values(state.players).find((p) => p.name.toLowerCase() === n);
      return hit ? hit.id : "";
    },
    [state.players]
  );

  // Set on every successful ESPN write; syncs inside the next 90s bypass the
  // 30s edge cache so a cached pre-write snapshot can never revert the app.
  const lastWriteRef = useRef(0);

  // -- roster ops (all synchronous against current state so errors surface now) --
  const doMove = useCallback(
    async (id, dest) => {
      const res = movePlayer(state, id, dest);
      if (res.error) {
        flash(res.error);
        setMoveId(null);
        return;
      }
      // With ESPN connected, an in-app move IS an ESPN move — written through
      // atomically so a refresh can never revert it.
      if (state.espn) {
        const here = findLocation(state, id);
        const occupantId = dest.zone === "lineup" ? state.lineup[dest.slotKey][dest.index] : state[dest.zone][dest.index];
        const moves = [
          { espnId: state.players[id]?.espnId, name: state.players[id]?.name, from: here, to: dest },
        ];
        if (occupantId) {
          moves.push({
            espnId: state.players[occupantId]?.espnId,
            name: state.players[occupantId]?.name,
            from: dest,
            to: here,
          });
        }
        flash("Writing to ESPN…");
        const w = await writeLineupMove(state, moves);
        if (!w.ok) {
          flash(`❌ ${w.error} — nothing changed. Re-syncing so the next try works.`);
          // A failed write usually means our picture drifted from ESPN's —
          // realign immediately (cache-busted) instead of leaving the user stuck.
          syncEspn(true, true);
          setMoveId(null);
          return;
        }
        lastWriteRef.current = Date.now();
        setState(res.state);
        flash(`✓ Lineup updated on ESPN — ${state.players[id]?.name} moved.`);
      } else {
        setState(res.state);
      }
      setMoveId(null);
    },
    [state, flash]
  );

  const onDrop = useCallback(
    (dest) => {
      if (!dragId) return;
      doMove(dragId, dest);
      setDragId(null);
    },
    [dragId, doMove]
  );

  const onStatus = useCallback(
    (id, status) => {
      const res = setStatus(state, id, status);
      if (res.error) flash(res.error);
      else setState(res.state);
    },
    [state, flash]
  );

  const onWeek = useCallback((id, patch) => setState((s) => setWeekData(s, id, s.week, patch)), []);

  const onEditPlayer = useCallback(
    (id, patch) => {
      const res = editPlayer(state, id, patch);
      if (res.error) return { error: res.error };
      setState(res.state);
      return {};
    },
    [state]
  );

  /** Apply one optimizer suggestion. */
  /** Optimizer suggestions go through the same write-through path as drags. */
  const applyMove = useCallback(
    (m) => doMove(m.inId, { zone: "lineup", slotKey: m.slotKey, index: m.index }),
    [doMove]
  );

  /** Plan the full set of moves locally, then ship them to ESPN as ONE atomic
   *  transaction — either the whole optimized lineup lands or nothing does. */
  const applyAllMoves = useCallback(async () => {
    const oppDists = opponentDistributions(state, state.week);
    let cur = state;
    const wireMoves = [];
    let applied = 0;
    for (let pass = 0; pass < 12; pass++) {
      if (wireMoves.length >= 8) break; // ESPN transaction cap is 10 items
      const moves = suggestLineup(cur, cur.week, oppDists);
      if (!moves.length) break;
      const m = moves[0];
      const dest = { zone: "lineup", slotKey: m.slotKey, index: m.index };
      const here = findLocation(cur, m.inId);
      const occ = cur.lineup[m.slotKey][m.index];
      const res = movePlayer(cur, m.inId, dest);
      if (res.error) break;
      wireMoves.push({ espnId: cur.players[m.inId]?.espnId, name: cur.players[m.inId]?.name, from: here, to: dest });
      if (occ) wireMoves.push({ espnId: cur.players[occ]?.espnId, name: cur.players[occ]?.name, from: dest, to: here });
      cur = res.state;
      applied++;
    }
    if (!applied) {
      flash("Nothing to change.");
      return;
    }
    if (state.espn) {
      flash("Writing lineup to ESPN…");
      const w = await writeLineupMove(state, wireMoves);
      if (!w.ok) {
        flash(`❌ ${w.error} — nothing changed. Re-syncing so the next try works.`);
        syncEspn(true, true);
        return;
      }
      lastWriteRef.current = Date.now();
    }
    setState(cur);
    flash(`✓ ${applied} lineup change${applied === 1 ? "" : "s"} applied${state.espn ? " on ESPN in one transaction" : ""}.`);
  }, [state, flash]);

  // -- watch list --
  const onAddWatch = useCallback(
    (entry) => {
      const res = addWatch(state, entry);
      if (res.error) return { error: res.error };
      setState(res.state);
      return {};
    },
    [state]
  );
  const onRemoveWatch = useCallback((id) => setState((s) => removeWatch(s, id)), []);

  // -- game log --
  const onAddCall = useCallback(
    (entry) => {
      const res = addCall(state, entry);
      if (res.error) return { error: res.error };
      setState(res.state);
      return {};
    },
    [state]
  );
  const onRemoveCall = useCallback((id) => setState((s) => removeCall(s, id)), []);
  const onCallOutcome = useCallback(
    (id, outcome) => setState((s) => setCallOutcome(s, id, outcome)),
    []
  );

  // -- interest --
  const onToggleInterest = useCallback(
    (entry) => {
      const res = toggleInterest(state, entry);
      if (res.error) return flash(res.error);
      setState(res.state);
      flash(res.added ? `Tracking ${entry.name}.` : `Stopped tracking ${entry.name}.`);
    },
    [state, flash]
  );

  // -- analytics from a pasted FantasyPros comparison --
  const onImportAnalytics = useCallback(
    (patches) => {
      setState((s) => {
        let next = s;
        for (const { player, patch } of patches) {
          next = setPlayerAnalytics(next, player.id, s.week, patch);
        }
        return next;
      });
      flash(`Imported analytics for ${patches.length} player${patches.length === 1 ? "" : "s"}.`);
    },
    [flash]
  );

  // -- ESPN sync --
  const [espnBusy, setEspnBusy] = useState(false);
  const syncEspn = useCallback(
    async (silent = false, fresh = false) => {
      if (espnBusy) return;
      setEspnBusy(true);
      try {
        // Recent write → always bypass the edge cache; a cached pre-write
        // snapshot would revert the lineup we just changed.
        const data = await fetchLeague(fresh || Date.now() - lastWriteRef.current < 90 * 1000);
        if (data.configured === false) {
          if (!silent) flash(data.reason || "ESPN sync isn't configured yet.");
          return;
        }
        setState((s) => {
          const res = applyEspnSync(s, data, MY_TEAM);
          if (res.error) {
            if (!silent) flash(res.error);
            return s;
          }
          flash(summaryToText(res.summary));
          return res.state;
        });
      } catch (e) {
        if (!silent) flash(`ESPN sync failed: ${e.message}`);
      } finally {
        setEspnBusy(false);
      }
    },
    [espnBusy, flash]
  );

  // Refresh from ESPN on load — silently, and never while viewing someone
  // else's shared team (their data isn't ours to overwrite).
  useEffect(() => {
    if (!loaded || viewingShared) return;
    const last = state.espn?.fetchedAt || 0;
    if (Date.now() - last > 10 * 60 * 1000) syncEspn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, viewingShared]);

  // Beat wire: ESPN's aggregated NFL news, refreshed each visit (30-min gate).
  const [news, setNews] = useState([]);
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        const base = import.meta.env.DEV ? "https://the-huddle-hq.vercel.app" : "";
        const r = await fetch(`${base}/api/news`, { cache: "no-store" });
        if (r.ok) {
          const d = await r.json();
          setNews(d.items || []);
        }
      } catch {
        /* news is enhancement */
      }
    })();
  }, [loaded]);

  /** News matched to the league pool: sleepers (low-rostered) and my players. */
  const beatWire = useMemo(() => {
    if (!news.length || !state.espn) return { sleepers: [], myNews: [], rest: [] };
    const pool = state.espn.pool || [];
    const byEspnId = new Map(pool.map((p) => [String(p.espnId), p]));
    const mine = new Set(Object.values(state.players).map((p) => String(p.espnId)).filter(Boolean));
    const sleepers = [];
    const myNews = [];
    const rest = [];
    for (const item of news.slice(0, 30)) {
      const hits = item.athleteIds.map((id) => byEspnId.get(id)).filter(Boolean);
      // "YOUR PLAYER" must headline YOUR players — not every league player
      // the story happens to mention.
      const mineHits = hits.filter((h) => mine.has(String(h.espnId)));
      if (mineHits.length) myNews.push({ ...item, players: mineHits });
      else {
        const sleeper = hits.find((p) => p.onTeamId === 0 && p.team && (p.percentOwned == null || p.percentOwned < 50));
        if (sleeper) sleepers.push({ ...item, sleeper });
        else rest.push({ ...item, players: hits });
      }
    }
    return { sleepers, myNews, rest: rest.slice(0, 6) };
  }, [news, state]);

  // Landing on Gameday always shows a fresh picture — roster moves made in
  // ESPN's own app appear within seconds, not after the 10-minute gate.
  useEffect(() => {
    if (tab !== "gameday" || !state.espn || viewingShared) return;
    if (Date.now() - (state.espn.fetchedAt || 0) > 2 * 60 * 1000) syncEspn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Vegas player props, fully automated: fetch once per session (server-side
  // cache protects API credits), match to my roster, auto-price as the
  // top-priority projection source. Manual paste survives as an override.
  const oddsDone = useRef(false);
  useEffect(() => {
    if (!loaded || viewingShared || oddsDone.current || !state.espn) return;
    oddsDone.current = true;
    (async () => {
      try {
        const base = import.meta.env.DEV ? "https://the-huddle-hq.vercel.app" : "";
        const r = await fetch(`${base}/api/odds`, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        if (!d.configured || !Array.isArray(d.players) || !d.players.length) return;
        const byName = new Map(d.players.map((p) => [p.name.toLowerCase().replace(/[^a-z]/g, ""), p]));
        setState((s) => {
          let next = s;
          let n = 0;
          for (const pl of Object.values(s.players)) {
            const hit = byName.get(pl.name.toLowerCase().replace(/[^a-z]/g, ""));
            if (!hit) continue;
            const computed = propsToPoints(hit.props, leagueScoring(s));
            if (!(computed.points > 0)) continue;
            next = setPlayerAnalytics(next, pl.id, s.week, {
              propsProj: computed.points,
              props: hit.props,
              propsParts: computed.parts,
              propsSource: "odds-api",
            });
            n++;
          }
          if (n) flash(`🎰 Vegas props auto-priced ${n} player${n === 1 ? "" : "s"}${d.remaining ? ` · ${d.remaining} API credits left` : ""}.`);
          return next;
        });
      } catch {
        /* props are enhancement */
      }
    })();
  }, [loaded, viewingShared, state.espn, flash]);

  // NFL schedule: opponents by week + auto byes. Weekly staleness window —
  // the league schedule barely changes once posted.
  useEffect(() => {
    if (!loaded || viewingShared) return;
    const last = state.schedule?.fetchedAt || 0;
    if (Date.now() - last < 7 * 24 * 3600 * 1000) return;
    (async () => {
      try {
        const data = await fetchSchedule();
        setState((s) => {
          const res = applySchedule(s, data);
          if (!res.skipped) flash(`NFL schedule loaded — byes set for ${res.byeCount} teams automatically.`);
          return res.state;
        });
      } catch {
        /* schedule is enhancement, not requirement */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, viewingShared]);

  // -- gameday --
  const onSetOpponent = useCallback(
    (wk, team) => setState((s) => setMatchupOpponent(s, wk, team)),
    []
  );
  const onSetLive = useCallback(
    (wk, rowKey, patch) => setState((s) => setLiveEntry(s, wk, rowKey, patch)),
    []
  );

  const onApplySwap = useCallback(
    (outId, inId) => {
      const loc = findLocation(state, outId);
      if (!loc || loc.zone !== "lineup") return flash("That player isn't in a starting slot.");
      // same write-through path as every other move
      doMove(inId, { zone: "lineup", slotKey: loc.slotKey, index: loc.index });
    },
    [state, flash, doMove]
  );

  // -- data panel --
  const onSetBye = useCallback((team, week) => setState((s) => setBye(s, team, week)), []);
  const onApplyByes = useCallback(
    (byes) => {
      setState((s) => mergeByes(s, byes));
      flash(`Bye weeks set for ${Object.keys(byes).length} teams.`);
    },
    [flash]
  );
  const onApplyEcr = useCallback(
    (updates, ecrIndex) => {
      setState((s) => {
        const players = { ...s.players };
        for (const u of updates) {
          if (players[u.id]) players[u.id] = { ...players[u.id], ecr: u.to };
        }
        return { ...s, players, ecrIndex };
      });
      flash(`Updated ${updates.length} ECR value${updates.length === 1 ? "" : "s"}.`);
    },
    [flash]
  );
  /** Vegas props become the top-priority projection for the current week. */
  const onApplyProps = useCallback(
    (propPlayers) => {
      setState((s) => {
        let next = s;
        for (const { player, props, computed } of propPlayers) {
          next = setPlayerAnalytics(next, player.id, s.week, {
            propsProj: computed.points,
            props,
            propsParts: computed.parts,
          });
        }
        return next;
      });
      flash(
        `Vegas projections set for ${propPlayers.length} player${propPlayers.length === 1 ? "" : "s"} — they now outrank expert numbers.`
      );
    },
    [flash]
  );

  const onImportTeam = useCallback(
    (incoming) => {
      setState(migrate(incoming));
      setDataOpen(false);
      setViewingShared(true);
      flash("Loaded shared team.");
    },
    [flash]
  );

  // -- live sync --
  const goLive = useCallback(async () => {
    const next = { id: newTeamId(), key: newWriteKey(), mode: "owner" };
    setSyncStatus("saving");
    try {
      await pushTeam(next.id, next.key, state);
      saveLink(next);
      setLink(next);
      setViewingShared(false);
      setSyncStatus("saved");
      setSyncError("");
      flash("Live sync on — share your team code with the league.");
      return {};
    } catch (e) {
      setSyncStatus("error");
      setSyncError(e.message);
      return { error: e.message };
    }
  }, [state, flash]);

  const stopLive = useCallback(() => {
    syncer.current.cancel();
    clearLink();
    setLink(null);
    setViewingShared(false);
    setSyncStatus("idle");
    setSyncError("");
    flash("Live sync off. Your team stays on this device.");
  }, [flash]);

  const joinTeam = useCallback(
    async (code) => {
      const clean = String(code || "").trim().toLowerCase().replace(/.*[?&]team=/, "");
      if (!/^[a-z0-9]{6,32}$/.test(clean)) return { error: "That doesn't look like a team code." };
      try {
        const res = await fetchTeam(clean);
        if (res.notFound) return { error: "No team with that code." };
        const nextLink = { id: clean, mode: "viewer" };
        setState(migrate(res.state));
        saveLink(nextLink);
        setLink(nextLink);
        setViewingShared(true);
        setDataOpen(false);
        flash("Following that team — it refreshes when you come back to the tab.");
        return {};
      } catch (e) {
        return { error: e.message };
      }
    },
    [flash]
  );

  const refreshLive = useCallback(async () => {
    if (!link) return;
    try {
      const res = await fetchTeam(link.id);
      if (res.notFound) return flash("That team is no longer published.");
      setState(migrate(res.state));
      flash("Pulled the latest.");
    } catch (e) {
      flash(e.message);
    }
  }, [link, flash]);

  const onAdd = useCallback(
    (form) => {
      const res = addPlayer(state, form);
      if (res.error) return { error: res.error };
      setState(res.state);
      flash(`${form.name.trim()} added to your bench.`);
      return {};
    },
    [state, flash]
  );

  const onDropPlayer = useCallback(
    (id) => {
      const res = dropPlayer(state, id);
      if (res.error) flash(res.error);
      else {
        setState(res.state);
        flash(`${res.removed.name} dropped.`);
      }
      setModalId(null);
    },
    [state, flash]
  );

  // -- claims --
  const addClaim = () => {
    if (!claimForm.player.trim()) return;
    const claim = {
      id: `c${Date.now()}`,
      player: claimForm.player.trim(),
      team: claimForm.team,
      pos: claimForm.pos || "WR",
      amount: parseInt(claimForm.amount, 10) || 0,
      result: claimForm.result,
      note: claimForm.note,
      dropPlayerId: resolveDropId(claimForm.dropPlayerId, claimForm.dropName),
      dropPlayerName: claimForm.dropName || "",
      effects: null,
    };

    let next = state;
    // With live ESPN sync, claims are plans — the sync detects the outcome
    // and the roster/FAAB truth comes from ESPN, so no side effects here.
    if (state.espn) {
      claim.result = "Pending";
    } else if (claim.result === "Won") {
      const res = applyWin(next, claim);
      if (res.error) {
        flash(res.error);
        return;
      }
      next = res.state;
      claim.effects = res.effects;
    }
    setState({ ...next, claims: [claim, ...next.claims] });
    setClaimForm({ player: "", team: "", pos: "", amount: "", result: "Pending", note: "", dropName: "", dropPlayerId: "" });
  };

  const setClaimResult = useCallback(
    (id, nextResult) => {
      const claim = state.claims.find((c) => c.id === id);
      if (!claim) return;
      // Sync era: results are bookkeeping only — ESPN owns roster and FAAB.
      if (state.espn) {
        setState({
          ...state,
          claims: state.claims.map((c) =>
            c.id === id ? { ...c, result: nextResult, effects: null, autoResolved: false } : c
          ),
        });
        return;
      }
      let next = state;
      let effects = claim.effects;

      if (claim.result === "Won" && nextResult !== "Won") {
        const res = revertWin(next, claim);
        if (res.error) {
          flash(res.error);
          return;
        }
        next = res.state;
        effects = null;
      } else if (claim.result !== "Won" && nextResult === "Won") {
        const res = applyWin(next, claim);
        if (res.error) {
          flash(res.error);
          return;
        }
        next = res.state;
        effects = res.effects;
      }
      setState({
        ...next,
        claims: next.claims.map((c) => (c.id === id ? { ...c, result: nextResult, effects } : c)),
      });
    },
    [state, flash]
  );

  /** Edit = revert (if won) → apply new values → re-apply (if won). */
  const editClaim = useCallback(
    (id, form) => {
      const claim = state.claims.find((c) => c.id === id);
      if (!claim) return { error: "Claim not found" };
      const wasWon = !state.espn && claim.result === "Won";
      let next = state;

      if (wasWon) {
        const rev = revertWin(next, claim);
        if (rev.error) return { error: rev.error };
        next = rev.state;
      }

      const updated = {
        ...claim,
        player: form.player.trim(),
        team: form.team,
        pos: form.pos || claim.pos || "WR",
        amount: parseInt(form.amount, 10) || 0,
        note: form.note,
        dropPlayerId: form.dropPlayerId || "",
        dropPlayerName: form.dropName || "",
        effects: null,
      };
      // resolve free-typed drop name against the post-revert roster
      if (!updated.dropPlayerId && updated.dropPlayerName) {
        const n = updated.dropPlayerName.trim().toLowerCase();
        const hit = Object.values(next.players).find((p) => p.name.toLowerCase() === n);
        if (hit) updated.dropPlayerId = hit.id;
      }

      if (wasWon) {
        const res = applyWin(next, updated);
        if (res.error) return { error: res.error };
        next = res.state;
        updated.effects = res.effects;
      }
      setState({ ...next, claims: next.claims.map((c) => (c.id === id ? updated : c)) });
      return {};
    },
    [state]
  );

  const deleteClaim = useCallback(
    (id) => {
      const claim = state.claims.find((c) => c.id === id);
      if (!claim) return;
      let next = state;
      if (!state.espn && claim.result === "Won") {
        const res = revertWin(next, claim);
        if (res.error) {
          flash(res.error);
          return;
        }
        next = res.state;
      }
      setState({ ...next, claims: next.claims.filter((c) => c.id !== id) });
    },
    [state, flash]
  );

  const rosterSearch = useCallback(
    (q, limit) => {
      const s = q.trim().toLowerCase();
      if (!s) return [];
      return Object.values(state.players)
        .filter((p) => p.name.toLowerCase().includes(s))
        .slice(0, limit)
        .map((p) => ({ name: p.name, team: p.team, pos: p.pos, id: p.id }));
    },
    [state.players]
  );

  /** Shared global lookup shaped for Autocomplete rows: rostered players
   *  surface with an owner badge instead of being invisible. */
  const leagueSearch = useCallback(
    (q, limit) => {
      const live = searchLeaguePlayers(state, q, limit);
      if (live.length) {
        return live.map((r) => ({
          name: r.name,
          team: r.team,
          pos: r.pos,
          owner: r.owner,
          badge: r.mine ? "YOURS" : r.owner ? `OWNED · ${r.owner}` : null,
        }));
      }
      // deep-stash fallback: the static FA name list still autocompletes
      return searchFreeAgents(q, limit);
    },
    [state]
  );

  /** Claim-form search: same engine (claims only make sense for free agents,
   *  so the owner badge is the "don't bother" signal). */
  const wireSearch = leagueSearch;

  const rowProps = {
    week,
    byes: state.byes || {},
    oppFor: (p) => scheduleOpp(state, p.team, week),
    projFor: (p) => pointDistribution(p, week, state)?.mean ?? null,
    dragId,
    legalKeys,
    onOpen: setModalId,
    onBadge: setMoveId,
    onDragStart: setDragId,
    onDragEnd: () => setDragId(null),
    onDrop,
  };

  let rowIndex = 0;

  return (
    <div>
      <header className="hero">
        <div className="hero-inner">
          <div className="hero-top">
            <div>
              <div className="hero-kicker">Team Headquarters</div>
              <h1 className="hero-title">The Huddle</h1>
              <div className="hero-sub">
                <span className="hero-break">Ready…BREAK</span>
              </div>
            </div>
            <div className="hero-badges">
              <label className="week-select">
                <span className="week-select-label">{weekShort(week)}</span>
                <select
                  value={week}
                  onChange={(e) => setState((s) => ({ ...s, week: e.target.value }))}
                  aria-label="Select week"
                >
                  {WEEKS.map((w) => (
                    <option key={w} value={w}>
                      {weekLabel(w)}
                    </option>
                  ))}
                </select>
                <span className="week-caret">▾</span>
              </label>
              <div className="badge-row">
                <button
                  className={`data-btn espn-btn ${state.espn ? "connected" : ""}`}
                  onClick={() => syncEspn(false)}
                  disabled={espnBusy}
                  title={
                    state.espn
                      ? `Last synced ${new Date(state.espn.fetchedAt).toLocaleTimeString()}`
                      : "Pull live rosters & projections from ESPN"
                  }
                >
                  {espnBusy ? "⟳ Syncing…" : state.espn ? "⟳ ESPN ✓" : "⟳ ESPN"}
                </button>
                <button className="data-btn" onClick={() => setDataOpen(true)} title="Import & share">
                  ⇄ Data
                </button>
                <span
                  className={`badge-sync ${
                    saveError || syncStatus === "error" ? "err" : link ? "live" : "ok"
                  } clickable`}
                  title={syncError || (link ? `Team code ${link.id} — tap to manage` : "Saved on this device")}
                  onClick={() => setDataOpen(true)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="pip" />
                  {saveError
                    ? "SAVE ERROR"
                    : !loaded
                    ? "LOADING"
                    : syncStatus === "error"
                    ? "SYNC ERROR"
                    : link
                    ? link.mode === "owner"
                      ? syncStatus === "saving"
                        ? "SYNCING"
                        : "LIVE"
                      : "FOLLOWING"
                    : "SYNCED"}
                </span>
              </div>
            </div>
          </div>
          <div style={{ height: 26 }} />
        </div>
      </header>

      <nav className="tabs-wrap">
        <div className="tabs">
          {[
            ["roster", "Roster"],
            ["lab", "Start/Sit"],
            ["gameday", "Gameday"],
            ["intel", "Intel"],
            ["watch", "Watchlist"],
            ["waivers", "Waivers"],
            ["log", "Game Log"],
          ].map(([key, label]) => (
            <button key={key} className={`tab-btn ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>
      </nav>

      <main className="content">
        {alerts.length > 0 && (
          <div className="alert-strip">
            {alerts.slice(0, 4).map((a) => (
              <div key={a.id} className={`alert-card ${a.level}`}>
                <span className="alert-icon">{a.icon}</span>
                <div className="alert-body-wrap">
                  <div className="alert-title">{a.title}</div>
                  <div className="alert-body">{a.body}</div>
                </div>
                <div className="alert-actions">
                  {a.tab !== tab && (
                    <button className="chip-btn" onClick={() => setTab(a.tab)}>
                      View
                    </button>
                  )}
                  {a.dismissible && (
                    <button className="btn-ghost" onClick={() => dismissAlert(a.id)} aria-label="Dismiss alert">
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {saveError && (
          <div className="hint-card" style={{ borderColor: "var(--negative)", color: "var(--negative)" }}>
            Save failed — your last change may not have been stored.
          </div>
        )}

        {tab === "roster" && (
          <div className="tab-panel" key="roster">
            {viewingShared && (
              <div className="hint-card shared-banner">
                {link && link.mode === "viewer" ? (
                  <>
                    You're following <strong>team {link.id}</strong> — this updates as they make changes. Anything you
                    edit here stays on your device and never reaches them.{" "}
                    <button className="banner-btn" onClick={stopLive}>
                      Stop following — back to my team
                    </button>
                  </>
                ) : (
                  <>
                    You're viewing a <strong>shared team snapshot</strong>. Changes you make here stay on this device
                    and won't affect whoever sent the link.
                  </>
                )}
              </div>
            )}
            <div className="hint-card">
              Drag a row to another slot to start or bench a player — or tap the <strong>slot badge</strong> for a
              move menu. Tap the card itself for the full breakdown, status, and this week's matchup. Blue rank =
              expert consensus (ECR) · ★ = matchup grade for {weekLabel(week)}.
            </div>

            <PlayerSearchPanel state={state} onToggleInterest={onToggleInterest} />

            <LeagueBrowser
              state={state}
              ecrIndex={mergedIndex}
              interested={state.watch}
              onToggleInterest={onToggleInterest}
            />

            <LineupCheck state={state} week={week} onApply={applyMove} onApplyAll={applyAllMoves} />

            <SectionHeader
              kicker="Depth chart"
              title="Starters"
              count={SLOT_DEFS.reduce((n, s) => n + s.count, 0)}
            />
            <div className="roster-list">
              {SLOT_DEFS.map((s) =>
                Array.from({ length: s.count }, (_, i) => {
                  const dest = { zone: "lineup", slotKey: s.key, index: i };
                  const id = state.lineup[s.key][i];
                  return (
                    <RosterRow
                      key={destKey(dest)}
                      dest={dest}
                      player={id ? state.players[id] : null}
                      index={rowIndex++}
                      {...rowProps}
                    />
                  );
                })
              )}
            </div>

            <SectionHeader
              kicker="Reserves"
              title="Bench"
              count={BENCH_SIZE}
              action={
                // With live ESPN sync, adds/drops happen on ESPN and flow in
                // automatically — a local add would be erased by the next
                // sync. The button only exists in offline fallback mode.
                !state.espn ? (
                  <button className="mini-btn" onClick={() => setAddOpen(true)}>
                    + Add player
                  </button>
                ) : null
              }
            />
            <div className="roster-list">
              {state.bench.map((id, i) => {
                const dest = { zone: "bench", index: i };
                return (
                  <RosterRow
                    key={destKey(dest)}
                    dest={dest}
                    player={id ? state.players[id] : null}
                    index={rowIndex++}
                    {...rowProps}
                  />
                );
              })}
            </div>

            <SectionHeader kicker="Injured reserve" title="IR" count={IR_SIZE} />
            <div className="hint-card subtle">
              IR spots don't count against your {MAX_ROSTER}-man roster. A player must be flagged <strong>IR</strong>{" "}
              in their status editor before they can be moved here.
            </div>
            <div className="roster-list">
              {state.ir.map((id, i) => {
                const dest = { zone: "ir", index: i };
                return (
                  <RosterRow
                    key={destKey(dest)}
                    dest={dest}
                    player={id ? state.players[id] : null}
                    index={rowIndex++}
                    {...rowProps}
                  />
                );
              })}
            </div>

            <div className="roster-summary">
              <span className="rs-total">
                Roster <strong>{total}</strong>/{MAX_ROSTER}
              </span>
              <span className="rs-ir">
                IR {irUsed}/{IR_SIZE}
              </span>
              {POSITIONS.map((p) => (
                <span key={p} className={`limit-chip ${(counts[p] || 0) >= POS_LIMITS[p] ? "full" : ""}`}>
                  {p} {counts[p] || 0}/{POS_LIMITS[p]}
                </span>
              ))}
            </div>

          </div>
        )}

        {tab === "lab" && (
          <div className="tab-panel" key="lab">
            <SectionHeader kicker="Decision engine" title="Start / Sit Lab" />
            <div className="hint-card">
              Compare up to four of your players against your real opponent — everything's automatic: ESPN
              projections, Vegas game lines, live player props, injuries. The simulator answers in{" "}
              <strong>win probability</strong>, not points, and flags when the betting market disagrees with ESPN's
              model — that disagreement is your risk meter.
            </div>
            <StartSitLab
              state={state}
              week={week}
              onImport={onImportAnalytics}
              onApplySwap={onApplySwap}
              flash={flash}
            />
          </div>
        )}

        {tab === "gameday" && (
          <Gameday
            key="gameday"
            state={state}
            week={week}
            onSetLive={onSetLive}
            onSetOpponent={onSetOpponent}
            onRefresh={syncEspn}
          />
        )}

        {tab === "log" && (
          <div className="tab-panel" key="log">
            <SectionHeader kicker="Decision archive" title="Game Log" count={state.calls.length} />
            <CallForm state={state} week={week} onAdd={onAddCall} />
            {state.calls.length === 0 && (
              <EmptyState title="No calls on the board yet" icon="↗">
                Log the start/sit, waiver, and trade calls you make so you can look back at the reasoning in week 12
                and see whether you were right.
              </EmptyState>
            )}
            {calibration && (
              <div className="card calib-card">
                <div className="calib-head">
                  <div>
                    <div className="section-kicker">Your track record</div>
                    <div className="strength-title">
                      {Math.round(calibration.rate * 100)}% right
                      <span className="calib-n"> · {calibration.total} graded</span>
                    </div>
                  </div>
                </div>
                <div className="calib-rows">
                  {["high", "medium", "low"].map((b) => {
                    const d = calibration.byConfidence[b];
                    if (!d) return null;
                    const r = d.right / d.n;
                    // The interesting failure is being confident and wrong.
                    const off = b === "high" && r < 0.6;
                    return (
                      <div key={b} className="calib-row">
                        <span className="calib-label">{b} confidence</span>
                        <div className="strength-track">
                          <div
                            className={`strength-fill ${off ? "bad" : r >= 0.6 ? "good" : "mid"}`}
                            style={{ width: `${Math.max(4, r * 100)}%` }}
                          />
                        </div>
                        <span className="calib-pct">
                          {Math.round(r * 100)}%
                          <span className="of"> ({d.n})</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
                {calibration.byConfidence.high && calibration.byConfidence.high.n >= 4 &&
                  calibration.byConfidence.high.right / calibration.byConfidence.high.n < 0.6 && (
                    <div className="calib-flag">
                      You're wrong more often than not on the calls you're most sure about — that's usually a sign of
                      over-weighting one signal.
                    </div>
                  )}
              </div>
            )}
            <div className="stack">
              {state.calls.map((c) => (
                <div key={c.id} className="card call-card" style={{ "--call-color": CALL_COLOR[c.type] || "var(--border-hi)" }}>
                  <div className="call-head">
                    <span className="call-player">{c.player}</span>
                    <span className="call-meta">
                      {c.week === "PRE" ? "Preseason" : `Wk ${c.week}`} · {c.type}
                      {c.confidence ? ` · ${"●".repeat(c.confidence)}` : ""}
                      <button className="btn-ghost" onClick={() => onRemoveCall(c.id)} aria-label="Delete call">
                        ✕
                      </button>
                    </span>
                  </div>
                  {c.reasoning && <div className="call-reasoning">{c.reasoning}</div>}
                  <div className="call-outcome">
                    <span className="outcome-label">How'd it go?</span>
                    <button
                      className={`chip-btn ${c.outcome === "right" ? "on-win" : ""}`}
                      onClick={() => onCallOutcome(c.id, c.outcome === "right" ? "pending" : "right")}
                    >
                      Right
                    </button>
                    <button
                      className={`chip-btn ${c.outcome === "wrong" ? "on-loss" : ""}`}
                      onClick={() => onCallOutcome(c.id, c.outcome === "wrong" ? "pending" : "wrong")}
                    >
                      Wrong
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "waivers" && (
          <div className="tab-panel" key="waivers">
            <SectionHeader kicker="Acquisition desk" title="FAAB Budget" />
            <div className="card faab-card">
              <div className="faab-row">
                <div>
                  <div className="faab-label">Remaining</div>
                  <span className="faab-amount">${state.faab}</span>
                </div>
                <div>
                  <div className="faab-spent-label">Spent</div>
                  <div className="faab-spent">${Math.max(0, 100 - state.faab)}</div>
                </div>
              </div>
              <div className="faab-bar">
                <div className="faab-fill" style={{ width: `${Math.max(0, Math.min(100, state.faab))}%` }} />
              </div>
              {state.espn && (
                <div className="panel-meta" style={{ marginTop: 9 }}>
                  Synced from ESPN's transaction ledger — updates itself when claims process.
                </div>
              )}
            </div>

            <SectionHeader kicker="Transaction entry" title="Log a Claim" />
            <div className="card">
              <label className="field">
                <span className="field-label">Player to add</span>
                <Autocomplete
                  value={claimForm.player}
                  onChange={(v) => setClaimForm((f) => ({ ...f, player: v, owner: null }))}
                  onPick={(item) =>
                    setClaimForm((f) => ({ ...f, player: item.name, team: item.team, pos: item.pos, owner: item.owner }))
                  }
                  search={wireSearch}
                  placeholder="Start typing — or enter any name"
                />
              </label>
              {claimForm.owner && claimForm.owner !== MY_TEAM && (
                <div className="inline-warn">
                  Heads up — <strong>{claimForm.player}</strong> is rostered by {claimForm.owner} in your league.
                </div>
              )}
              <label className="field">
                <span className="field-label">Player to drop</span>
                <Autocomplete
                  value={claimForm.dropName}
                  onChange={(v) => setClaimForm((f) => ({ ...f, dropName: v, dropPlayerId: "" }))}
                  onPick={(item) => setClaimForm((f) => ({ ...f, dropName: item.name, dropPlayerId: item.id }))}
                  search={rosterSearch}
                  placeholder="From your roster (optional)"
                />
              </label>
              <div className="claim-form-row">
                <label className="field" style={{ width: 120 }}>
                  <span className="field-label">$ Bid</span>
                  <input
                    placeholder="0"
                    inputMode="numeric"
                    value={claimForm.amount}
                    onChange={(e) => setClaimForm((f) => ({ ...f, amount: e.target.value }))}
                  />
                </label>
                {!state.espn && (
                  <label className="field" style={{ width: 120 }}>
                    <span className="field-label">Result</span>
                    <select
                      value={claimForm.result}
                      onChange={(e) => setClaimForm((f) => ({ ...f, result: e.target.value }))}
                    >
                      {["Pending", "Won", "Lost"].map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <label className="field">
                <span className="field-label">Note</span>
                <input
                  placeholder="Note (dropped player, reasoning)"
                  value={claimForm.note}
                  onChange={(e) => setClaimForm((f) => ({ ...f, note: e.target.value }))}
                />
              </label>
              <button className="btn-primary" style={{ marginTop: 14 }} onClick={addClaim}>
                + Add claim
              </button>
              <div className="form-hint">
                {state.espn ? (
                  <>
                    Claims are <strong>plans</strong> — after waivers run, the ESPN sync detects what happened: the
                    player lands on your roster (won), on someone else's (lost — it names who outbid you), or stays
                    free. FAAB syncs from ESPN automatically.
                  </>
                ) : (
                  <>
                    Marking a claim <strong>Won</strong> deducts the bid from FAAB, adds the player to your bench, and
                    drops the named player. Un-marking restores all three.
                  </>
                )}
              </div>
            </div>

            <SectionHeader kicker="Ledger" title="Claim History" count={state.claims.length} />
            {state.claims.length === 0 && (
              <EmptyState title="No waiver claims logged" icon="$">
                Your submitted claims will appear here with bid amount, result, and notes.
              </EmptyState>
            )}
            <div className="stack">
              {state.claims.map((c) => (
                <ClaimCard
                  key={c.id}
                  claim={c}
                  state={state}
                  onEdit={editClaim}
                  onResult={setClaimResult}
                  onDelete={deleteClaim}
                />
              ))}
            </div>
          </div>
        )}

        {tab === "intel" && (
          <div className="tab-panel" key="intel">
            <SectionHeader kicker="Camp buzz & breaking reports" title="Beat Wire" />
            <div className="hint-card">
              The NFL news wire, cross-checked against your league every time you open the app. Low-rostered names in
              the headlines get flagged <strong>💤 SLEEPER?</strong> — star one and the watchlist engine takes over.
            </div>
            {beatWire.sleepers.length === 0 && beatWire.myNews.length === 0 && (
              <EmptyState title="Nothing on the wire yet" icon="📰">
                News refreshes on every visit — check back after games and practices.
              </EmptyState>
            )}
            <div className="stack">
              {beatWire.myNews.slice(0, 4).map((n, i) => (
                <div key={`my-${i}`} className="card news-card mine">
                  <div className="news-tag gold">🏈 YOUR PLAYER</div>
                  <div className="news-player">
                    {(n.players || []).slice(0, 2).map((p) => p.name).join(" · ") || "Your roster"}
                  </div>
                  <a className="news-head" href={n.link} target="_blank" rel="noreferrer">
                    {n.headline}
                  </a>
                  <div className="news-body">{n.description}</div>
                </div>
              ))}
              {beatWire.sleepers.slice(0, 6).map((n, i) => {
                const s = n.sleeper;
                const starred = (state.watch || []).some(
                  (w) => w.name.toLowerCase().replace(/[^a-z]/g, "") === s.name.toLowerCase().replace(/[^a-z]/g, "")
                );
                return (
                  <div key={`sl-${i}`} className="card news-card sleeper">
                    <div className="news-tag green">
                      💤 SLEEPER?
                      <button
                        className={`star-btn ${starred ? "on" : ""}`}
                        title={starred ? "Tracking" : "Add to watchlist"}
                        onClick={() => onToggleInterest({ name: s.name, team: s.team, pos: s.pos })}
                      >
                        {starred ? "★" : "☆"}
                      </button>
                    </div>
                    <div className="news-player">
                      {s.name}
                      <span className="news-player-meta">
                        {s.pos} · {s.team} · {s.percentOwned != null ? `${Math.round(s.percentOwned)}% rostered` : "low rostered"}
                      </span>
                    </div>
                    <a className="news-head" href={n.link} target="_blank" rel="noreferrer">
                      {n.headline}
                    </a>
                    <div className="news-body">{n.description}</div>
                  </div>
                );
              })}
            </div>

            {cliffs.some((c) => c.cliff) && (
              <>
                <SectionHeader kicker="Plan ahead" title="Bye Cliffs" />
                <div className="hint-card subtle">
                  Weeks where several of your players sit out at once — waiver help is cheapest{" "}
                  <strong>before</strong> everyone else needs it too.
                </div>
                <div className="stack">
                  {cliffs
                    .filter((c) => c.cliff)
                    .map((c) => (
                      <div key={c.week} className="card cliff-row">
                        <span className="cliff-week">WK {c.week}</span>
                        <span className="cliff-body">
                          <strong>{c.players.length} players out:</strong> {c.players.join(", ")}
                        </span>
                      </div>
                    ))}
                </div>
              </>
            )}

            <SectionHeader kicker="Where you're thin" title="Team Strength" />
            <StrengthCard state={state} onOpenData={() => setDataOpen(true)} />
          </div>
        )}

        {tab === "watch" && (
          <div className="tab-panel" key="watch">
            <SectionHeader
              kicker="Free-agent radar"
              title="Waiver Watch"
              count={state.watch.length}
              action={
                <button className="mini-btn" onClick={() => setWatchOpen((o) => !o)}>
                  {watchOpen ? "Close" : "+ Add name"}
                </button>
              }
            />
            <div className="hint-card">
              Track <strong>any</strong> player — free agent, on someone else's roster, or your own. Ownership is
              checked live against the {LEAGUE_ROSTERS.length} rosters in your league, so an entry never goes stale
              the way a hand-kept list does. Star players from the league browser on the Roster tab.
            </div>

            {watchOpen && <WatchForm onAdd={onAddWatch} onDone={() => setWatchOpen(false)} search={leagueSearch} />}


            {suggestions.length > 0 && (
              <>
                <SectionHeader kicker="Fit for your roster" title="Suggested Adds" count={suggestions.length} />
                <div className="hint-card subtle">
                  Genuinely available players who would <strong>upgrade a position group</strong>, ordered by how
                  badly you need them — not by raw rank. A mid WR beats the best available kicker when you're last in
                  the league at WR.
                </div>
                <div className="stack">
                  {suggestions.map((p) => {
                    const starred = (state.watch || []).some(
                      (w) => w.name.toLowerCase().replace(/[^a-z]/g, "") === p.name.toLowerCase().replace(/[^a-z]/g, "")
                    );
                    const rivals = rosterCompetition(state, p.pos);
                    const upcoming = nextOpponents(state, p.team, week, 3);
                    return (
                      <div key={`${p.name}-${p.team}`} className="card wire-row sug-row">
                        <span className="pos-chip" style={{ background: SLOT_COLOR[p.pos] || "var(--border-hi)" }}>
                          {p.pos}
                        </span>
                        <span className="wire-name">
                          {p.name}
                          <span className="sug-reason">{p.reason}</span>
                          {upcoming && p.team && (
                            <span className="sug-sched">next: {upcoming.join(" · ")}</span>
                          )}
                          {(() => {
                            const drop = dropCandidateFor(p.pos);
                            const addRos = rosPoints(state, p.team, p.proj);
                            if (addRos == null || !drop || drop.p.name === p.name) return null;
                            const dropRos = rosPoints(state, drop.p.team, drop.proj) ?? 0;
                            const delta = addRos - dropRos;
                            if (delta <= 0) return null;
                            return (
                              <span className="sug-ros">
                                ≈ <strong>+{delta} pts</strong> rest of season vs dropping {drop.p.name} (
                                {rosWeeks(state, p.team)} games left · projection-based)
                              </span>
                            );
                          })()}
                          {rivals && rivals.length > 0 && (
                            <span className="sug-rivals">
                              ⚠ {rivals.map((r) => r.team).slice(0, 2).join(" & ")}
                              {rivals.length > 2 ? ` +${rivals.length - 2}` : ""} also thin at {p.pos} — expect
                              competition
                            </span>
                          )}
                          {rivals && rivals.length === 0 && (
                            <span className="sug-clear">✓ nobody else in the league is hurting at {p.pos}</span>
                          )}
                        </span>
                        <TeamChip abbr={p.team} />
                        <span className="ecr-badge">#{p.rank}</span>
                        <button
                          className={`star-btn ${starred ? "on" : ""}`}
                          title={starred ? "Tracking" : "Track this player"}
                          onClick={() => onToggleInterest({ name: p.name, team: p.team, pos: p.pos })}
                        >
                          {starred ? "★" : "☆"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <SectionHeader kicker="Players you're tracking" title="Your Watchlist" count={state.watch.length} />
            <div className="interest-filters">
              {[
                ["all", "All"],
                ["free", "Available"],
                ["taken", "Rostered"],
              ].map(([k, label]) => (
                <button
                  key={k}
                  className={`filter-chip ${interestFilter === k ? "on" : ""}`}
                  onClick={() => setInterestFilter(k)}
                >
                  {label}
                  <span className="filter-count">{interestCounts[k]}</span>
                </button>
              ))}
            </div>

            <div className="stack" style={{ marginTop: 12 }}>
              {filteredInterest.length === 0 && (
                <EmptyState title="Nothing here" icon="☆">
                  {interestFilter === "all"
                    ? "Star a player from the league browser or add one above."
                    : "No tracked players match that filter."}
                </EmptyState>
              )}
              {filteredInterest.map((w) => {
                const normW = w.name.toLowerCase().replace(/[^a-z]/g, "");
                const mine = Object.values(state.players).some(
                  (p) => p.name.toLowerCase().replace(/[^a-z]/g, "") === normW
                );
                const owner = mine ? MY_TEAM : ownerOf(w.name);
                const verified = state.espn ? !owner && !mine : isVerifiedAvailable(w.name);
                const wi = !mine && state.espn ? watchIntelById[w.id] : null;
                return (
                  <div key={w.id} className={`card wi-card ${wi ? `wi-${wi.tone}` : ""}`}>
                    <div className="watch-head">
                      <span className="watch-name">
                        {w.name}
                        {wi && (
                          <span className={`wi-tier ${wi.tone}`} title={wi.blurb}>
                            {wi.icon} {wi.label}
                          </span>
                        )}
                      </span>
                      <span className="watch-right">
                        {(wi?.pos || w.pos) && <span className="pos-mini">{wi?.pos || w.pos}</span>}
                        <TeamChip abbr={wi?.team || w.team} />
                        <span
                          className={`avail-pill ${mine ? "mine" : owner ? "taken" : verified ? "free" : "unknown"}`}
                        >
                          {mine ? "ON YOUR TEAM" : owner ? `ROSTERED · ${owner}` : verified ? "FREE AGENT" : "UNCONFIRMED"}
                        </span>
                        <button className="btn-ghost" onClick={() => onRemoveWatch(w.id)} aria-label={`Remove ${w.name}`}>
                          ✕
                        </button>
                      </span>
                    </div>

                    {wi && wi.synced && (
                      <>
                        <div className="wi-metrics">
                          <span className="wi-metric">
                            <em>proj</em>
                            {wi.proj != null ? wi.proj : "—"}
                          </span>
                          <span className="wi-metric">
                            <em>{wi.pos} rank</em>
                            {wi.rank != null ? `#${wi.rank}` : "—"}
                          </span>
                          <span className="wi-metric">
                            <em>rostered</em>
                            {wi.owned != null ? `${Math.round(wi.owned)}%` : "—"}
                          </span>
                          {wi.upgradeRanks != null && (
                            <span className={`wi-metric ${wi.upgradeRanks > 0 ? "up" : "down"}`}>
                              <em>vs your {wi.pos}s</em>
                              {wi.upgradeRanks > 0 ? `+${wi.upgradeRanks} better` : `${wi.upgradeRanks}`}
                            </span>
                          )}
                          {wi.bid != null && !owner && (
                            <span className="wi-metric bid" title="Heuristic: upgrade size + live competition, capped at 45% of your FAAB">
                              <em>open bid</em>${wi.bid}
                            </span>
                          )}
                        </div>

                        {wi.schedule && (
                          <div className="wi-sched">
                            next: {wi.schedule.join(" · ")}
                            {wi.byeWk && <span className="wi-bye"> · bye wk {wi.byeWk}</span>}
                          </div>
                        )}

                        {wi.coveredCliffs.length > 0 && (
                          <div className="wi-note good">
                            ✓ plays through your week {wi.coveredCliffs.join(" & ")} bye crisis — extra value to you
                          </div>
                        )}
                        {wi.collidingCliffs.length > 0 && (
                          <div className="wi-note bad">
                            ✗ his bye is week {wi.collidingCliffs.join(" & ")} — same week your roster craters
                          </div>
                        )}
                        {!owner && wi.rivals.length > 0 && (
                          <div className="wi-note warn">
                            ⚠ {wi.rivals.map((r) => r.team).slice(0, 2).join(" & ")} thin at {wi.pos} — don't lowball
                          </div>
                        )}
                      </>
                    )}

                    {w.note && <div className="watch-note">{w.note}</div>}
                    {owner && !mine && (
                      <div className="watch-hint">Not claimable — this is a trade conversation with {owner}.</div>
                    )}
                  </div>
                );
              })}
            </div>

            <SectionHeader kicker="Actually available" title="Top of the Wire" count={topAvailable.length} />
            <div className="hint-card subtle">
              Best unrostered players by ECR, filtered against every roster in the league. Positions you're thin at
              are worth a look first.
            </div>
            <div className="stack">
              {topAvailable.length === 0 && (
                <EmptyState title="Nothing ranked yet" icon="↗">
                  Paste a ranking set from the Data panel and this fills with the best genuinely-available players.
                </EmptyState>
              )}
              {topAvailable.map((p) => {
                const starred = isInterested(state, p.name);
                return (
                  <div
                    key={`${p.name}-${p.team}`}
                    className={`card wire-row clickable ${starred ? "watching" : ""}`}
                    role="button"
                    tabIndex={0}
                    title={starred ? "On your watchlist — click to remove" : "Click to add to your watchlist"}
                    onClick={() => onToggleInterest({ name: p.name, team: p.team, pos: p.pos })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onToggleInterest({ name: p.name, team: p.team, pos: p.pos });
                      }
                    }}
                  >
                    <span className="pos-chip" style={{ background: SLOT_COLOR[p.pos] || "var(--border-hi)" }}>
                      {p.pos}
                    </span>
                    <span className="wire-name">{p.name}</span>
                    <TeamChip abbr={p.team} />
                    <span className="ecr-badge">{p.rank != null ? `#${p.rank}` : "—"}</span>
                    <span className={`star-btn ${starred ? "on" : ""}`} aria-hidden="true">
                      {starred ? "★" : "☆"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>

      <footer className="site-footer">
        <span>The Huddle · Team HQ</span>
        <span>Data saved on this device</span>
      </footer>

      {notice && <div className="toast">{notice}</div>}

      {modalId && (
        <PlayerModal
          state={state}
          playerId={modalId}
          week={week}
          onClose={() => setModalId(null)}
          onStatus={onStatus}
          onWeek={onWeek}
          onEdit={onEditPlayer}
          onMoveOpen={(id) => {
            setModalId(null);
            setMoveId(id);
          }}
          onDrop={onDropPlayer}
        />
      )}
      {moveId && <MoveSheet state={state} playerId={moveId} onClose={() => setMoveId(null)} onMove={doMove} />}
      {addOpen && <AddPlayerModal state={state} onClose={() => setAddOpen(false)} onAdd={onAdd} />}
      {dataOpen && (
        <DataPanel
          state={state}
          onClose={() => setDataOpen(false)}
          onApplyEcr={onApplyEcr}
          onApplyByes={onApplyByes}
          onSetBye={onSetBye}
          onImportTeam={onImportTeam}
          onApplyProps={onApplyProps}
          flash={flash}
          link={link}
          syncStatus={syncStatus}
          syncError={syncError}
          onGoLive={goLive}
          onStopLive={stopLive}
          onJoinTeam={joinTeam}
          onRefreshLive={refreshLive}
          liveUrl={link ? liveShareUrl(link.id) : ""}
        />
      )}
    </div>
  );
}
