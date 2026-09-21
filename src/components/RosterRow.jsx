// One roster row: drag source, drop target, and tap-to-move affordance.
//
// Extracted verbatim from App.jsx (code-health step 3). Behaviour
// unchanged — this is a file move, pinned by the render smoke test.

import { useState, useEffect } from "react";
import { teamOf } from "../data/teams.js";
import { weekData } from "../lineup.js";
import { effectiveStatus, isOnBye } from "../analysis.js";
import { beginDragAutoScroll, stopDragAutoScroll } from "../dragScroll.js";
import { SLOT_COLOR, destKey, zoneLabel } from "../constants.js";
import { Avatar, StatusPill, Stars, TeamChip } from "./ui/index.jsx";

export default function RosterRow({
  dest,
  player,
  week,
  byes,
  oppFor,
  projFor,
  liveFor,
  index,
  dragId,
  legalKeys,
  onOpen,
  onBadge,
  onDragStart,
  onDragEnd,
  onDrop,
  coarse,
}) {
  const [over, setOver] = useState(false);
  const label = zoneLabel(dest);
  const key = destKey(dest);
  const isLegalTarget = !!dragId && legalKeys.has(key);
  const isSource = dragId && player && dragId === player.id;

  // A row can scroll out from under the pointer mid-drag; without this its
  // "over" highlight would stay stuck on after the drag ended elsewhere.
  useEffect(() => {
    if (!dragId && over) setOver(false);
  }, [dragId, over]);
  // Never leave a scroll loop running if this row unmounts mid-drag.
  useEffect(() => () => stopDragAutoScroll(), []);

  const badgeColor = SLOT_COLOR[label] || "var(--border-hi)";
  // DESIGN.md's three states, approved for anywhere a player row renders.
  // Without this the roster screen showed a projection for a player whose
  // game had finished, with nothing on the row to say the number was stale.
  const g = player && liveFor ? liveFor(player) : null;
  const shown = g && g.value != null ? g.value : projFor ? projFor(player) : null;
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
        // onDragEnd is passed as the teardown callback too: under touch the
        // browser can abandon a drag without ever firing dragend, which used
        // to leave this card stuck in .dragging forever.
        beginDragAutoScroll(e.currentTarget, onDragEnd);
        onDragStart(player.id);
      }}
      onDragEnd={() => {
        stopDragAutoScroll();
        onDragEnd();
      }}
      onDragOver={handleDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        stopDragAutoScroll();
        setOver(false);
        // Carry the player id in the drop event itself rather than relying on
        // React state still holding it. A teardown path that cleared dragId
        // could otherwise swallow a drop that genuinely landed.
        const carried = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
        onDrop(dest, carried || null);
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
        {/* On touch this is the ONLY way to move a player — HTML5 drag never
            fires on iOS — so it gets an explicit label and a 44px target
            instead of a 9px caret whose `title` can never be hovered. */}
        <button
          type="button"
          className={`slot-tag tappable ${coarse ? "touch-move" : ""}`}
          style={{ background: badgeColor }}
          title="Move player"
          aria-label={`Move ${player.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onBadge(player.id);
          }}
        >
          {label}
          <span className="slot-tag-caret">⇅</span>
          {coarse && <span className="slot-tag-move">MOVE</span>}
        </button>
        <Avatar player={player} />
        <div className="player-info">
          <div className="player-name-row">
            {/* FINAL recedes to muted slate: ten rows then collapse into
                "here's what's left" without reading a word. */}
            <span className={`player-name ${g && g.isFinal ? "spent" : ""}`}>{player.name}</span>
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
          {shown != null && (
            <span className="row-num">
              <span
                className={`row-proj ${g ? (g.isFinal || g.isLive ? "isfinal" : "") : ""}`}
                title={
                  g && g.isFinal
                    ? "Final — what he actually scored"
                    : g && g.isLive
                      ? "Live: points he has banked so far"
                      : "Projected points this week (props > ESPN, Vegas-tilted)"
                }
              >
                {shown}
              </span>
              {/* Two numbers ONLY while live: what he has banked, with the
                  projected finish under it. A projection is dead once the game
                  ends, and showing both invites a comparison that no longer
                  means anything. */}
              {g && g.sub != null && <span className={`row-sub ${g.dir}`}>{g.sub}</span>}
            </span>
          )}
          <span className="ecr-badge">{player.ecr || "—"}</span>
          <Stars n={wd.matchup} />
        </div>
      </div>
      {/* Every state carries a WORD as well as a colour — colour alone fails a
          glance in sunlight and fails a colour-blind reader completely. */}
      {g && (
        <div className="row-state-line">
          <b className={`row-state ${g.isFinal ? "final" : g.isLive ? "live" : "pre"}`}>{g.chip}</b>
          <span className="row-track">
            <i
              className={g.isFinal ? "done" : g.isLive ? "on" : ""}
              style={{ width: `${Math.round(Math.max(0, Math.min(1, g.prog)) * 100)}%` }}
            />
          </span>
        </div>
      )}
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

