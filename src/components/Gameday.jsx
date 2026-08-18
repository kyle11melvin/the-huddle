import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { LEAGUE_ROSTERS, MY_TEAM } from "../data/leagueRosters.js";
import { SLOT_DEFS, weekLabel } from "../lineup.js";
import { pointDistribution, playerAnalytics } from "../analytics.js";
import { simulateLive, liveNarrative } from "../simulate.js";
import { teamLogoUrl } from "../data/teams.js";
import { espnTeamRoster, liveEntryFor, anyGameLive } from "../espnSync.js";
import { scheduleOpp } from "../scheduleSync.js";

const CV = { QB: 0.32, RB: 0.5, WR: 0.58, TE: 0.6, K: 0.42, "D/ST": 0.72 };
// ESPN's raw injury strings → play probability (bimodal injury pricing).
const PLAY_PROB = { QUESTIONABLE: 0.77, DOUBTFUL: 0.25, OUT: 0, INJURY_RESERVE: 0, SUSPENSION: 0 };
const STARTER_SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "D/ST", "K"];
const STATUSES = [
  ["notStarted", "Not started"],
  ["inProgress", "Playing"],
  ["final", "Final"],
];

const pct = (n) => `${Math.round(n * 100)}%`;
const key = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

// Live first (that's where the game is), then upcoming, finals last — and
// inside each group, familiar slot order so the QB is always up top.
const STATUS_RANK = { inProgress: 0, notStarted: 1, final: 2 };
const SLOT_RANK = { QB: 0, RB: 1, WR: 2, TE: 3, FLEX: 4, "D/ST": 5, K: 6 };

const kickoffOf = (l) => {
  const d = (l && l.detail) || "";
  const m = /-\s*(.+)$/.exec(d);
  return (m ? m[1] : d).replace(/\s*(EDT|EST|PT|CT|MT)\s*$/, "").trim();
};

/**
 * MODULE SCOPE, deliberately. Defined inside Gameday's body this was a new
 * component *type* on every render, so React unmounted and remounted every
 * row — which destroyed the fallback "Scored" input on each keystroke and
 * took focus with it. Rows receive their already-resolved live entry.
 */
const Row = ({ row, l, autoMode, isOpen, onToggle, onSetLive, week }) => {
  const status = l.status || "notStarted";
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
        onClick={() => !autoMode && onToggle(isOpen ? null : row.k)}
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
            <select value={status} onChange={(e) => onSetLive(week, row.k, { status: e.target.value })}>
              {STATUSES.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          {status === "inProgress" && (
            <label className="field" style={{ flex: 1, minWidth: 130 }}>
              <span className="field-label">Game left · {Math.round((l.pctRemaining ?? 1) * 100)}%</span>
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

/**
 * Live matchup view. The number that matters is "chance to win given who still
 * has football left" — a lead means nothing if the other side has three players
 * yet to play, and a deficit means nothing if you have Monday night left.
 */
export default function Gameday({ state, week, onSetLive, onSetOpponent, onRefresh }) {
  // While any NFL game is being played, poll ESPN so scores and the win bar
  // move on their own — no tapping required.
  // The 120s live poll. Depending on [state, onRefresh] meant the interval was
  // torn down and recreated on every state change and every syncEspn identity
  // change — i.e. constantly — so it never survived long enough to fire once.
  // During a live Sunday the app looked like it was auto-refreshing and wasn't.
  // Depend on a BOOLEAN, and hold the callback in a ref so its identity churn
  // can't reset the timer.
  const gamesLive = anyGameLive(state);
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);
  useEffect(() => {
    if (!gamesLive) return undefined;
    const t = setInterval(() => refreshRef.current && refreshRef.current(true), 120000);
    return () => clearInterval(t);
  }, [gamesLive]);
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

  /** Opposing NFL team this week, for the sim's correlation structure. */
  const nflOpp = (team) => {
    const a = (scheduleOpp(state, team, week) || "").replace(/^@/, "").trim().toUpperCase();
    return a && a !== "BYE" ? a : null;
  };

  /** Starters for any league team, straight from the synced rosters. */
  const teamRows = (mappedName, prefix) => {
    const r = espnTeamRoster(state, mappedName);
    if (!r) return [];
    return r
      .filter((e) => e.slot !== "BE" && e.slot !== "IR")
      .map((e) => {
        const playProb = PLAY_PROB[e.injuryStatus] ?? 1;
        const proj = Number.isFinite(e.proj) && e.proj > 0 ? e.proj : null;
        return {
          slot: e.slot,
          name: e.name,
          team: e.team,
          pos: e.pos,
          k: `${prefix}:${key(e.name)}`,
          // displayed number = EXPECTED points (injury-priced) so the column
          // still sums to the simulated header
          proj: proj != null ? Math.round(proj * playProb * 10) / 10 : null,
          simProj: proj, // if-he-plays projection, for the simulator
          playProb,
          cv: CV[e.pos] ?? 0.55,
        };
      });
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
          // dist.mean is already injury-priced (expected points)
          proj: dist ? dist.mean : a && a.proj ? a.proj : null,
          simProj: dist ? dist.condMean ?? dist.mean : a && a.proj ? a.proj : null,
          playProb: dist ? dist.playProb ?? 1 : 1,
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
        .map((e) => {
          const playProb = PLAY_PROB[e.injuryStatus] ?? 1;
          const proj = Number.isFinite(e.proj) && e.proj > 0 ? e.proj : null;
          return {
            slot: e.slot,
            name: e.name,
            team: e.team,
            pos: e.pos,
            k: `opp:${key(e.name)}`,
            proj: proj != null ? Math.round(proj * playProb * 10) / 10 : null,
            simProj: proj,
            playProb,
            cv: CV[e.pos] ?? 0.55,
            estimated: false,
          };
        });
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
      // if-he-plays projection; the sim applies playProb itself (bimodal)
      proj: row.simProj ?? row.proj ?? 0,
      playProb: row.playProb ?? 1,
      scored: Number.isFinite(l.scored) ? l.scored : 0,
      pctRemaining: Number.isFinite(l.pctRemaining) ? l.pctRemaining : 1,
      status: l.status || "notStarted",
      cv: row.cv,
      // correlation metadata: same NFL game → shared factor in the sim
      team: row.team || null,
      pos: row.pos || null,
      opp: row.team ? nflOpp(row.team) : null,
    };
  };

  // Left/right sides: mine when viewing my matchup, otherwise any two teams
  // from the league board — same simulation either way.
  const leftRows = useMemo(
    () => (viewingMine ? mySide : teamRows(selected.awayName, "l")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewingMine, mySide, selected, state.espn, week]
  );
  const rightRows = useMemo(
    () => (viewingMine ? oppSide : teamRows(selected.homeName, "r")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewingMine, oppSide, selected, state.espn, week]
  );
  const leftName = viewingMine ? MY_TEAM : selected.awayName;
  const rightName = viewingMine ? oppTeam || (selected && selected.homeName) || "" : selected.homeName;

  // Resolve each row's live entry ONCE per data change, then sort on it.
  // sortRows used to call resolveLive inside the comparator (O(n log n) live
  // lookups per render), and the 20k-draw sim below ran on every render —
  // including ones triggered by something as unrelated as a toast expiring.
  const withLive = useCallback(
    (rows) => rows.map((r) => ({ ...r, l: resolveLive(r) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autoMode, live, state.espn]
  );
  const sortResolved = (rows) =>
    [...rows].sort((a, b) => {
      const s = (STATUS_RANK[a.l.status || "notStarted"] ?? 1) - (STATUS_RANK[b.l.status || "notStarted"] ?? 1);
      if (s !== 0) return s;
      return (SLOT_RANK[a.slot] ?? 9) - (SLOT_RANK[b.slot] ?? 9);
    });

  const leftResolved = useMemo(() => sortResolved(withLive(leftRows)), [leftRows, withLive]);
  const rightResolved = useMemo(() => sortResolved(withLive(rightRows)), [rightRows, withLive]);

  const myEntries = useMemo(
    () => leftResolved.filter((r) => r.name && r.proj != null).map(entryFor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leftResolved, state.schedule, week]
  );
  const oppEntries = useMemo(
    () => rightResolved.filter((r) => r.name && r.proj != null).map(entryFor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rightResolved, state.schedule, week]
  );
  const sim = useMemo(
    () => (myEntries.length && oppEntries.length ? simulateLive(myEntries, oppEntries) : null),
    [myEntries, oppEntries]
  );
  const narrative = useMemo(() => liveNarrative(sim), [sim]);

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
            {leftResolved.map((r) => (
              <Row
                key={r.k}
                row={r}
                l={r.l}
                autoMode={autoMode}
                isOpen={!autoMode && editing === r.k}
                onToggle={setEditing}
                onSetLive={onSetLive}
                week={week}
              />
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
            {rightResolved.map((r) => (
              <Row
                key={r.k}
                row={r}
                l={r.l}
                autoMode={autoMode}
                isOpen={!autoMode && editing === r.k}
                onToggle={setEditing}
                onSetLive={onSetLive}
                week={week}
              />
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
