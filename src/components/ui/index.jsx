// Presentational primitives, extracted from App.jsx (code-health step 1).
// Pure and stateless — no app state, no handlers beyond what's passed in.
import { useState, useEffect } from "react";
import { teamOf, headshotUrl, teamLogoUrl } from "../../data/teams.js";
import { STATUS_LABEL } from "../../constants.js";

export function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ player, className = "" }) {
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

export function StatusPill({ status }) {
  if (!status) return null;
  const bg = status === "O" || status === "IR" ? "var(--negative)" : status === "BYE" ? "var(--text-dim)" : "#c99514";
  return (
    <span className="status-pill" style={{ background: bg }}>
      {status}
    </span>
  );
}

export function Stars({ n }) {
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

export function StarPicker({ value, onChange }) {
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

export function TeamChip({ abbr }) {
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

export function SectionHeader({ kicker, title, count, action }) {
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

export function EmptyState({ title, icon = "↗", children }) {
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
