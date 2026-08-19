import { useState, useMemo } from "react";
import { LEAGUE_ROSTERS, MY_TEAM } from "../data/leagueRosters.js";
import { teamOf, teamLogoUrl, headshotUrl } from "../data/teams.js";
import { espnTeamRoster, normName } from "../espnSync.js";
import { scheduleOpp } from "../scheduleSync.js";
import { SLOT_COLOR } from "../constants.js";


const SLOT_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, FLEX: 4, "D/ST": 5, K: 6, BE: 7, BN: 7, IR: 8 };
const STARTER_SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "D/ST", "K"];
const INJ = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O", INJURY_RESERVE: "IR", SUSPENSION: "O" };

/**
 * Full-information browser for every roster in the league. When the ESPN sync
 * is live, opponent rows carry the same intel as your own: headshot, weekly
 * projection, position rank, this week's opponent, injury tag.
 */
export default function LeagueBrowser({ state, ecrIndex, interested, onToggleInterest }) {
  const [team, setTeam] = useState(MY_TEAM);
  const [open, setOpen] = useState(false);

  const rank = (name) => (ecrIndex && ecrIndex[normName(name)]) ?? null;
  const interestedSet = useMemo(() => new Set((interested || []).map((w) => normName(w.name))), [interested]);

  // Live rows when synced; static transcription as fallback.
  const rows = useMemo(() => {
    const live = state && espnTeamRoster(state, team);
    if (live) {
      return [...live]
        .sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9))
        .map((e) => ({
          slot: e.slot === "BE" ? "BN" : e.slot,
          name: e.name,
          nfl: e.team,
          pos: e.pos,
          espnId: e.espnId,
          proj: Number.isFinite(e.proj) && e.proj > 0 ? e.proj : null,
          inj: INJ[e.injuryStatus] || "",
          live: true,
        }));
    }
    const t = LEAGUE_ROSTERS.find((x) => x.team === team) || LEAGUE_ROSTERS[0];
    return [
      ...t.starters.map((p, i) => ({ slot: STARTER_SLOTS[i] || "FLEX", name: p[0], nfl: p[1], pos: p[2] })),
      ...t.bench.map((p) => ({ slot: "BN", name: p[0], nfl: p[1], pos: p[2] })),
      ...(t.ir || []).map((p) => ({ slot: "IR", name: p[0], nfl: p[1], pos: p[2] })),
    ];
  }, [state, team]);

  const showRows = team !== MY_TEAM;

  return (
    <div className="card league-browser">
      <div className="lb-head">
        <button className="lb-switch" onClick={() => setOpen((o) => !o)}>
          <span className="lb-name">{team}</span>
          {team === MY_TEAM && <span className="lb-mine">YOU</span>}
          <span className={`lb-caret ${open ? "open" : ""}`}>▾</span>
        </button>
        {showRows ? (
          <button className="mini-btn" onClick={() => setTeam(MY_TEAM)}>
            ← My team
          </button>
        ) : (
          <span className="lb-count">{rows.length} players</span>
        )}
      </div>

      {open && (
        <div className="lb-menu">
          {LEAGUE_ROSTERS.map((t) => (
            <button
              key={t.team}
              className={`lb-option ${t.team === team ? "active" : ""}`}
              onClick={() => {
                setTeam(t.team);
                setOpen(false);
              }}
            >
              {t.team}
              {t.team === MY_TEAM && <span className="lb-mine">YOU</span>}
            </button>
          ))}
        </div>
      )}

      {!showRows && (
        <div className="lb-own-hint">
          That's you — your full roster is right below. Pick another owner to see their squad with full intel, star
          anyone you want to track.
        </div>
      )}

      {showRows && (
        <div className="lb-rows">
          {rows.map((r, i) => {
            const t = teamOf(r.nfl);
            const shot = r.espnId ? headshotUrl(r.espnId) : teamLogoUrl(r.nfl);
            const rk = rank(r.name);
            const opp = state ? scheduleOpp(state, r.nfl, state.week) : "";
            const isInt = interestedSet.has(normName(r.name));
            return (
              <div key={`${r.name}-${i}`} className="lb-row rich" style={{ "--team-ring": t.ring }}>
                <span className="lb-slot" style={{ background: SLOT_COLOR[r.slot] || "var(--border-hi)" }}>
                  {r.slot}
                </span>
                <span className="lb-shot">
                  {shot && <img src={shot} alt="" loading="lazy" onError={(e) => (e.target.style.display = "none")} />}
                </span>
                <span className="lb-info">
                  <span className="lb-player">
                    {r.name}
                    {r.inj && <span className="status-pill" style={{ background: r.inj === "O" || r.inj === "IR" ? "var(--negative)" : "#c99514", marginLeft: 6 }}>{r.inj}</span>}
                  </span>
                  <span className="lb-sub">
                    {r.pos} · {r.nfl || "FA"}
                    {opp && ` · vs ${opp}`}
                  </span>
                </span>
                {r.proj != null && (
                  <span className="lb-proj" title="ESPN weekly projection">
                    {r.proj}
                  </span>
                )}
                {rk != null && <span className="lb-rank">#{rk}</span>}
                <button
                  className={`star-btn ${isInt ? "on" : ""}`}
                  title={isInt ? "Remove from watchlist" : "Track this player"}
                  onClick={() => onToggleInterest({ name: r.name, team: r.nfl, pos: r.pos })}
                >
                  {isInt ? "★" : "☆"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showRows && (
        <div className="lb-foot">
          {state && state.espn ? "Live from ESPN — projections, injuries and lineups as of last sync." : "Transcribed snapshot — connect ESPN for live data."}
        </div>
      )}
    </div>
  );
}
