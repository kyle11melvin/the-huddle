import { useState, useMemo, useEffect } from "react";
import { LEAGUE_ROSTERS, MY_TEAM } from "../data/leagueRosters.js";
import { SLOT_DEFS, weekLabel } from "../lineup.js";
import { pointDistribution, playerAnalytics } from "../analytics.js";
import { simulateLive, liveNarrative } from "../simulate.js";
import { teamLogoUrl } from "../data/teams.js";
import { espnTeamRoster, liveEntryFor, anyGameLive } from "../espnSync.js";

const CV = { QB: 0.32, RB: 0.5, WR: 0.58, TE: 0.6, K: 0.42, "D/ST": 0.72 };
const STARTER_SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "D/ST", "K"];
const STATUSES = [
  ["notStarted", "Not started"],
  ["inProgress", "Playing"],
  ["final", "Final"],
];

const pct = (n) => `${Math.round(n * 100)}%`;
const key = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * Live matchup view. The number that matters is "chance to win given who still
 * has football left" — a lead means nothing if the other side has three players
 * yet to play, and a deficit means nothing if you have Monday night left.
 */
export default function Gameday({ state, week, onSetLive, onSetOpponent, onRefresh }) {
  // While any NFL game is being played, poll ESPN so scores and the win bar
  // move on their own — no tapping required.
  useEffect(() => {
    if (!onRefresh || !anyGameLive(state)) return;
    const t = setInterval(() => onRefresh(true), 120000);
    return () => clearInterval(t);
  }, [state, onRefresh]);
  const [editing, setEditing] = useState(null);
  const board = (state.matchups && state.matchups[week]) || {};
  const oppTeam = board.oppTeam || "";
  const live = board.live || {};
  // Declared up top: everything below (sims, rows, sorting) branches on it.
  const autoMode = !!state.espn;

  const oppRoster = useMemo(() => LEAGUE_ROSTERS.find((t) => t.team === oppTeam), [oppTeam]);

  // Every matchup in the league this week, scores live from ESPN.
  const [viewIdx, setViewIdx] = useState(null);
  const leagueBoard = useMemo(() => {
    if (!state.espn) return [];
    const teams = new Map((state.espn.teams || []).map((t) => [t.id, t]));
    return (state.espn.matchups || []).map((m) => {
      const home = teams.get(m.home);
      const away = teams.get(m.away);
      return {
        homeName: (home && (home.mapped || home.name)) || "?",
        awayName: (away && (away.mapped || away.name)) || "?",
        homeScore: Math.round((m.homeScore || 0) * 10) / 10,
        awayScore: Math.round((m.awayScore || 0) * 10) / 10,
        isMine: m.home === state.espn.myTeamId || m.away === state.espn.myTeamId,
      };
    });
  }, [state.espn]);

  const selected = viewIdx != null ? leagueBoard[viewIdx] : leagueBoard.find((m) => m.isMine) || null;
  const viewingMine = !selected || selected.isMine;

  /** Starters for any league team, straight from the synced rosters. */
  const teamRows = (mappedName, prefix) => {
    const r = espnTeamRoster(state, mappedName);
    if (!r) return [];
    return r
      .filter((e) => e.slot !== "BE" && e.slot !== "IR")
      .map((e) => ({
        slot: e.slot,
        name: e.name,
        team: e.team,
        pos: e.pos,
        k: `${prefix}:${key(e.name)}`,
        proj: Number.isFinite(e.proj) && e.proj > 0 ? e.proj : null,
        cv: CV[e.pos] ?? 0.55,
      }));
  };

  // My starters, in slot order.
  const mySide = useMemo(() => {
    const out = [];
    for (const s of SLOT_DEFS) {
      for (let i = 0; i < s.count; i++) {
        const id = state.lineup[s.key][i];
        const p = id ? state.players[id] : null;
        if (!p) {
          out.push({ slot: s.key, name: null, k: `${s.key}${i}` });
          continue;
        }
        const dist = pointDistribution(p, week, state);
        const a = playerAnalytics(state, p.id, week);
        out.push({
          slot: s.key,
          name: p.name,
          team: p.team,
          pos: p.pos,
          k: `me:${p.id}`,
          proj: dist ? dist.mean : a && a.proj ? a.proj : null,
          cv: CV[p.pos] ?? 0.55,
        });
      }
    }
    return out;
  }, [state, week]);

  const oppSide = useMemo(() => {
    // Live ESPN roster + real projections when a sync has happened.
    const live = espnTeamRoster(state, oppTeam);
    if (live) {
      return live
        .filter((e) => e.slot !== "BE" && e.slot !== "IR")
        .map((e) => ({
          slot: e.slot,
          name: e.name,
          team: e.team,
          pos: e.pos,
          k: `opp:${key(e.name)}`,
          proj: Number.isFinite(e.proj) && e.proj > 0 ? e.proj : null,
          cv: CV[e.pos] ?? 0.55,
          estimated: false,
        }));
    }
    if (!oppRoster) return [];
    return oppRoster.starters.map(([name, team, pos], i) => {
      const rank = state.ecrIndex ? state.ecrIndex[key(name)] : null;
      const proj = rank != null ? Math.max(4, 22 - Math.log2(Math.max(1, rank)) * 3.1) : null;
      return {
        slot: STARTER_SLOTS[i] || "FLEX",
        name,
        team,
        pos,
        k: `opp:${key(name)}`,
        proj: proj != null ? Math.round(proj * 10) / 10 : null,
        cv: CV[pos] ?? 0.55,
        estimated: true,
      };
    });
  }, [state, oppTeam, oppRoster]);

  // Auto mode: the ESPN feed is the only truth — stale manual entries from
  // the old tap-to-edit days would otherwise mark players "live" forever.
  // Manual entries only matter in the no-ESPN fallback.
  const resolveLive = (row) => {
    if (autoMode) return liveEntryFor(state, row.name, row.team) || {};
    const manual = live[row.k];
    if (manual && (manual.status || Number.isFinite(manual.scored))) return manual;
    return liveEntryFor(state, row.name, row.team) || {};
  };

  const entryFor = (row) => {
    const l = resolveLive(row);
    return {
      proj: row.proj || 0,
      scored: Number.isFinite(l.scored) ? l.scored : 0,
      pctRemaining: Number.isFinite(l.pctRemaining) ? l.pctRemaining : 1,
      status: l.status || "notStarted",
      cv: row.cv,
    };
  };

  // Left/right sides: mine when viewing my matchup, otherwise any two teams
  // from the league board — same simulation either way.
  const leftRows = viewingMine ? mySide : teamRows(selected.awayName, "l");
  const rightRows = viewingMine ? oppSide : teamRows(selected.homeName, "r");
  const leftName = viewingMine ? MY_TEAM : selected.awayName;
  const rightName = viewingMine ? oppTeam || (selected && selected.homeName) || "" : selected.homeName;

  const myEntries = leftRows.filter((r) => r.name && r.proj != null).map(entryFor);
  const oppEntries = rightRows.filter((r) => r.name && r.proj != null).map(entryFor);
  const sim = myEntries.length && oppEntries.length ? simulateLive(myEntries, oppEntries) : null;
  const narrative = liveNarrative(sim);

  // Live sync makes manual status entry obsolete — the editor only exists as
  // a fallback when ESPN isn't connected. Rows are never hidden; status is
  // pure styling: live pulse, dimmed final with a check, kickoff for upcoming.
  const kickoffOf = (l) => {
    const d = l.detail || "";
    const m = /-\s*(.+)$/.exec(d);
    return (m ? m[1] : d).replace(/\s*(EDT|EST|PT|CT|MT)\s*$/, "").trim();
  };

  // Live first (that's where the game is), then upcoming, finals last —
  // and inside each group, familiar slot order so the QB is always up top.
  const STATUS_RANK = { inProgress: 0, notStarted: 1, final: 2 };
  const SLOT_RANK = { QB: 0, RB: 1, WR: 2, TE: 3, FLEX: 4, "D/ST": 5, K: 6 };
  const sortRows = (rows) =>
    [...rows].sort((a, b) => {
      const s =
        (STATUS_RANK[resolveLive(a).status || "notStarted"] ?? 1) -
        (STATUS_RANK[resolveLive(b).status || "notStarted"] ?? 1);
      if (s !== 0) return s;
      return (SLOT_RANK[a.slot] ?? 9) - (SLOT_RANK[b.slot] ?? 9);
    });

  const Row = ({ row, side }) => {
    const l = resolveLive(row);
    const status = l.status || "notStarted";
    const isOpen = !autoMode && editing === row.k;
    const logo = teamLogoUrl(row.team);
    if (!row.name) {
      return (
        <div className="gd-row empty">
          <span className="gd-slot">{row.slot}</span>
          <span className="gd-name dim">Empty</span>
        </div>
      );
    }
    return (
      <>
        <div
          className={`gd-row ${status}`}
          onClick={() => !autoMode && setEditing(isOpen ? null : row.k)}
          style={autoMode ? { cursor: "default" } : undefined}
        >
          <span className="gd-slot">{row.slot}</span>
          <span className="gd-logo">{logo && <img src={logo} alt="" loading="lazy" />}</span>
          <span className="gd-name">
            {status === "inProgress" && <span className="gd-live-dot" />}
            {row.name}
          </span>
          <span className="gd-proj">{row.proj != null ? row.proj : "—"}</span>
          <span className={`gd-score ${status === "final" ? "final" : ""}`}>
            {Number.isFinite(l.scored) ? l.scored : "—"}
          </span>
          <span className={`gd-status ${status}`} title={l.detail || ""}>
            {status === "final"
              ? "✓"
              : status === "inProgress"
              ? `${Math.round((1 - (l.pctRemaining ?? 1)) * 100)}%`
              : kickoffOf(l) || "—"}
          </span>
        </div>
        {isOpen && (
          <div className="gd-edit">
            <label className="field" style={{ width: 92 }}>
              <span className="field-label">Scored</span>
              <input
                inputMode="decimal"
                value={l.scored ?? ""}
                onChange={(e) => onSetLive(week, row.k, { scored: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label className="field" style={{ width: 120 }}>
              <span className="field-label">Status</span>
              <select
                value={status}
                onChange={(e) => onSetLive(week, row.k, { status: e.target.value })}
              >
                {STATUSES.map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {status === "inProgress" && (
              <label className="field" style={{ flex: 1, minWidth: 130 }}>
                <span className="field-label">
                  Game left · {Math.round((l.pctRemaining ?? 1) * 100)}%
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round((l.pctRemaining ?? 1) * 100)}
                  onChange={(e) => onSetLive(week, row.k, { pctRemaining: Number(e.target.value) / 100 })}
                />
              </label>
            )}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="tab-panel">
      <div className="section-head">
        <div className="section-kicker">Live matchup</div>
        <div className="section-title-row">
          <h2 className="section-title">Gameday</h2>
          <span className="section-count">{weekLabel(week)}</span>
        </div>
      </div>

      {/* League scoreboard: every matchup this week, yours highlighted.
          The opponent is never chosen by hand — the sync knows the schedule. */}
      {leagueBoard.length > 0 && (
        <div className="gd-league">
          {leagueBoard.map((m, i) => (
            <button
              key={i}
              className={`gd-mini ${m.isMine ? "mine" : ""} ${viewIdx === i ? "active" : ""}`}
              onClick={() => setViewIdx(i)}
            >
              <span className="gd-mini-row">
                <span className="gd-mini-name">{m.awayName}</span>
                <span className="gd-mini-score">{m.awayScore}</span>
              </span>
              <span className="gd-mini-row">
                <span className="gd-mini-name">{m.homeName}</span>
                <span className="gd-mini-score">{m.homeScore}</span>
              </span>
              {m.isMine && <span className="gd-mini-tag">YOU</span>}
            </button>
          ))}
        </div>
      )}
      {!oppTeam && leagueBoard.length === 0 && (
        <div className="hint-card subtle">Your opponent sets itself from the ESPN schedule on sync.</div>
      )}

      {sim && (
        <div className="card gd-hero">
          <div className="gd-scores">
            <div className="gd-team">
              <div className="gd-team-name">{leftName}</div>
              <div className="gd-total">{sim.myNow}</div>
              <div className="gd-proj-final">proj {sim.myProjFinal}</div>
              <div className="gd-left">{sim.myLeft} yet to play</div>
            </div>
            <div className="gd-vs">VS</div>
            <div className="gd-team right">
              <div className="gd-team-name">{rightName}</div>
              <div className="gd-total">{sim.oppNow}</div>
              <div className="gd-proj-final">proj {sim.oppProjFinal}</div>
              <div className="gd-left">{sim.oppLeft} yet to play</div>
            </div>
          </div>

          <div className="gd-prob-label">{viewingMine ? "Chance to win" : `${leftName} win chance`}</div>
          <div className="gd-prob-bar">
            <div className="gd-prob-mine" style={{ width: `${sim.winProb * 100}%` }}>
              <span>{pct(sim.winProb)}</span>
            </div>
            <div className="gd-prob-theirs">
              <span>{pct(1 - sim.winProb - sim.tieProb)}</span>
            </div>
          </div>
          {viewingMine && narrative && <div className="gd-narrative">{narrative}</div>}
          {viewingMine && (
            <div className="sim-fine">
              Your range if the week finished a thousand different ways: {sim.myP10}–{sim.myP90}.{" "}
              {state.espn
                ? "Both sides use real ESPN projections."
                : "Opponent projections are estimated from expert ranks until ESPN sync is connected."}
            </div>
          )}
        </div>
      )}

      {viewingMine && !oppTeam && !sim && (
        <EmptyBox>Your matchup appears automatically once the ESPN sync runs — nothing to set up.</EmptyBox>
      )}

      {(leftRows.length > 0 || rightRows.length > 0) && (
        <div className="gd-boards">
          <div className="gd-board">
            <div className="gd-board-head">{leftName}</div>
            <div className="gd-cols">
              <span>SLOT</span>
              <span className="grow">PLAYER</span>
              <span>PROJ</span>
              <span>PTS</span>
              <span>ST</span>
            </div>
            {sortRows(leftRows).map((r) => (
              <Row key={r.k} row={r} side="me" />
            ))}
          </div>
          <div className="gd-board">
            <div className="gd-board-head">{rightName}</div>
            <div className="gd-cols">
              <span>SLOT</span>
              <span className="grow">PLAYER</span>
              <span>PROJ</span>
              <span>PTS</span>
              <span>ST</span>
            </div>
            {sortRows(rightRows).map((r) => (
              <Row key={r.k} row={r} side="opp" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyBox({ children }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">▦</div>
      <div>
        <div className="empty-body" style={{ marginTop: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
