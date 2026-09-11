import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { LEAGUE_ROSTERS, MY_TEAM } from "../data/leagueRosters.js";
import { SLOT_DEFS, weekLabel } from "../lineup.js";
import { pointDistribution, playerAnalytics } from "../analytics.js";
import { simulateLive, liveProjection, opponentSource, espnAgeMs, staleAfterMs, agoLabel } from "../simulate.js";
import { teamLogoUrl, headshotUrl, teamOf } from "../data/teams.js";
import { pairBySlot, shortName, yetToPlay, yetToPlayLabel, seedFor, recordLabel, kickoffLabel, opponentOf, pairingEdge } from "../headToHead.js";
import { SLOT_COLOR } from "../constants.js";
import { espnTeamRoster, liveEntryFor, anyGameLive } from "../espnSync.js";
import { scheduleOpp } from "../scheduleSync.js";
import { byeWeekFor } from "../analysis.js";
import { untilKick } from "../timeUntil.js";

const CV = { QB: 0.32, RB: 0.5, WR: 0.58, TE: 0.6, K: 0.42, "D/ST": 0.72 };
// ESPN's raw injury strings → play probability (bimodal injury pricing).
const PLAY_PROB = { QUESTIONABLE: 0.77, DOUBTFUL: 0.25, OUT: 0, INJURY_RESERVE: 0, SUSPENSION: 0 };
// ESPN injury strings -> the short tag shown inline. ACTIVE is deliberately
// absent: a healthy player carries no tag.
const INJ_TAG = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O", INJURY_RESERVE: "IR", SUSPENSION: "O" };
/**
 * AccuWeather condition id -> one glyph. Grouped by band rather than
 * enumerated: the exact id matters far less than "is it going to affect the
 * football", and a 40-entry table would be 40 chances to be subtly wrong.
 * An indoor venue short-circuits this entirely — the roof is the forecast.
 */
function wxGlyph(game) {
  if (!game) return null;
  if (game.indoor) return { icon: "⌂", label: "Indoor" };
  const w = game.wx;
  if (!w || w.c == null) return null;
  const id = Number(w.c);
  const t = Number.isFinite(w.t) ? `${w.t}°` : "";
  const label = [w.d, t].filter(Boolean).join(" ");
  if (id >= 1 && id <= 5) return { icon: "☀", label };
  if (id >= 6 && id <= 11) return { icon: "☁", label };
  if ((id >= 12 && id <= 18) || (id >= 39 && id <= 42)) return { icon: "🌧", label };
  if ((id >= 19 && id <= 29) || (id >= 43 && id <= 44)) return { icon: "❄", label };
  if (id >= 30 && id <= 31) return { icon: "🌡", label };
  if (id >= 32 && id <= 34) return { icon: "💨", label };
  return { icon: "☁", label };
}

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
  const liveProj = liveProjection({
    pregame: row.proj,
    ifPlays: row.simProj ?? row.proj,
    scored: l.scored,
    pctRemaining: l.pctRemaining,
    status,
    playProb: row.playProb ?? 1,
  });
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
        <span className={`gd-proj ${status === "inProgress" ? "gd-proj-live" : ""}`}>
          {liveProj != null ? liveProj : "—"}
        </span>
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
export default function Gameday({ state, week, onSetLive, onSetOpponent, onRefresh, onOpenRow }) {
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
          status: p.status || "",
          bye: byeWeekFor(state.byes || {}, p.team),
          pos: p.pos,
          k: `me:${p.id}`,
          id: p.id,
          espnId: p.espnId || "",
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
            // ESPN sends ACTIVE for healthy players, and charAt(0) turned that
            // into an "A" badge on every opponent — a healthy-player warning.
            // Only real designations get a tag.
            status: INJ_TAG[e.injuryStatus] || "",
            bye: byeWeekFor(state.byes || {}, e.team),
            k: `opp:${key(e.name)}`,
            espnId: e.espnId || "",
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

  // Sorted by SLOT, not by live status — the two columns only mean anything if
  // row N on the left is the same slot as row N on the right.
  const pairs = useMemo(() => pairBySlot(leftResolved, rightResolved), [leftResolved, rightResolved]);

  // What firepower is LEFT on each side, by slot.
  const leftYtp = useMemo(() => yetToPlay(leftResolved), [leftResolved]);
  const rightYtp = useMemo(() => yetToPlay(rightResolved), [rightResolved]);

  // "0-0 (#4)". No @handle: api/espn.js does not extract owner handles from
  // ESPN's payload, so there is nothing to render — inventing one would be
  // worse than leaving it out.
  const subFor = useCallback(
    (teamName) => {
      const teams = (state.espn && state.espn.teams) || [];
      const t = teams.find((x) => (x.mapped || x.name) === teamName);
      if (!t) return "";
      const rec = recordLabel(t.record);
      const seed = seedFor(teams, t.id);
      return seed ? `${rec} (#${seed})` : rec;
    },
    [state.espn]
  );
  const leftSub = subFor(leftName);
  const rightSub = subFor(rightName);

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

  // Does ANY of my starters' games have a ball in the air? The hero's
  // hierarchy flips on this: pre-kickoff the projection is the story and the
  // score is noise; once live the score is the story.
  const anyLive = useMemo(
    () => [...leftResolved, ...rightResolved].some((r) => r && r.l && r.l.status === "inProgress"),
    [leftResolved, rightResolved]
  );
  const projMargin = sim ? Math.round((sim.myProjFinal - sim.oppProjFinal) * 10) / 10 : 0;
  const myDrift = sim && Number.isFinite(sim.myPregame) ? Math.round((sim.myProjFinal - sim.myPregame) * 10) / 10 : null;
  const oppDrift = sim && Number.isFinite(sim.oppPregame) ? Math.round((sim.oppProjFinal - sim.oppPregame) * 10) / 10 : null;


  // Say what the numbers on screen actually ARE. Asked directly of the code
  // that produces them, never inferred from `state.espn` being present — that
  // blob outlives the sync that filled it, which is how a screen ends up
  // claiming real projections while running rank estimates.
  const oppProvenance = useMemo(() => {
    const src = opponentSource(state, week, oppTeam);
    const age = espnAgeMs(state);
    if (src === "estimated") {
      return {
        tag: "NOT SYNCED",
        warn:
          "Opponent projections are estimated from expert ranks, and are not adjusted for injuries — a ruled-out starter is still valued as if healthy. Re-sync ESPN for real numbers.",
      };
    }
    if (src === "live" && age != null && age > staleAfterMs(state)) {
      return {
        tag: "STALE",
        warn: `Last ESPN sync was ${agoLabel(age)} ago. Scores and projections are frozen at that moment — tap ⟳ ESPN to refresh.`,
      };
    }
    return { tag: "", warn: "" };
  }, [state, week, oppTeam]);

  const Row = ({ row, side }) => {
    const l = resolveLive(row);
    const status = l.status || "notStarted";
    // Same function the sim above uses — see simulate.js. These two used to
    // disagree, which is how a row read 22.2 with a quarter left.
    const liveProj = liveProjection({
      pregame: row.proj,
      ifPlays: row.simProj ?? row.proj,
      scored: l.scored,
      pctRemaining: l.pctRemaining,
      status,
      playProb: row.playProb ?? 1,
    });
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
          <span className={`gd-proj ${status === "inProgress" ? "gd-proj-live" : ""}`}>
            {liveProj != null ? liveProj : "—"}
          </span>
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

      {!oppTeam && leagueBoard.length === 0 && (
        <div className="hint-card subtle">Your opponent sets itself from the ESPN schedule on sync.</div>
      )}

      {sim && (
        <div className={`card gd-hero ${viewingMine ? "mine" : ""}`}>
          <div className="gd-scores">
            {/* myTeam is ALWAYS the left column. Anchored once, threaded
                everywhere — the page previously let each section decide, which
                is how a reader ends up attributing the wrong side to himself. */}
            <div className="gd-team">
              <div className="gd-team-name">{leftName}</div>
              <div className="gd-team-rec">{leftSub}</div>
              {anyLive ? (
                <>
                  <div className="gd-total live">{sim.myNow}</div>
                  <div className="gd-proj-final">
                    proj {sim.myProjFinal}
                    {myDrift != null && (
                      <b className={myDrift >= 0 ? "up" : "down"}>
                        {myDrift >= 0 ? " ▲" : " ▼"}
                        {Math.abs(myDrift).toFixed(1)}
                      </b>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Pre-kickoff everyone is near zero and the score is noise. */}
                  <div className="gd-total proj">{sim.myProjFinal}</div>
                  <div className="gd-scored">{sim.myNow} scored</div>
                </>
              )}
            </div>

            <div className="gd-vs">
              <span className={`gd-margin ${projMargin >= 0 ? "up" : "down"}`}>
                {projMargin >= 0 ? "+" : "−"}
                {Math.abs(projMargin).toFixed(1)}
              </span>
            </div>

            <div className="gd-team right">
              <div className="gd-team-name">{rightName}</div>
              <div className="gd-team-rec">{rightSub}</div>
              {anyLive ? (
                <>
                  <div className="gd-total live">{sim.oppNow}</div>
                  <div className="gd-proj-final">
                    proj {sim.oppProjFinal}
                    {oppDrift != null && (
                      <b className={oppDrift >= 0 ? "up" : "down"}>
                        {oppDrift >= 0 ? " ▲" : " ▼"}
                        {Math.abs(oppDrift).toFixed(1)}
                      </b>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="gd-total proj">{sim.oppProjFinal}</div>
                  <div className="gd-scored">{sim.oppNow} scored</div>
                </>
              )}
            </div>
          </div>

          {/* Gold is ALWAYS you, slate is ALWAYS them, and both carry a word.
              Green read as "good" and pointed at whichever side happened to be
              favoured, which is a colour-only signal saying the wrong thing. */}
          <div className="gd-prob-keys">
            <span className="gd-key-you">{viewingMine ? "You" : leftName} {pct(sim.winProb)}</span>
            <span className="gd-key-them">{viewingMine ? "Him" : rightName} {pct(1 - sim.winProb - sim.tieProb)}</span>
          </div>
          <div className="gd-prob-bar">
            <div className="gd-prob-mine" style={{ width: `${sim.winProb * 100}%` }} />
            <div className="gd-prob-theirs" />
          </div>

          {/* Yet to play, once — with the POSITIONS, because 8-vs-10 only means
              something when you can see who still holds a QB. */}
          <div className="gd-ytp">
            <div className="gd-ytp-box">
              <b>{leftYtp.count} players</b>
              <span>{yetToPlayLabel(leftYtp) || "none left"}</span>
            </div>
            <div className="gd-ytp-box r">
              <b>{rightYtp.count} players</b>
              <span>{yetToPlayLabel(rightYtp) || "none left"}</span>
            </div>
          </div>

          {/* The narrative callout and the P10-P90 fine print lived here. Both
              restated what the number, the bar and the two "players left" boxes
              already say — three sentences of prose under a 58px score is noise,
              not intelligence. The provenance warning below stays: it only
              appears when the opponent data is actually suspect. */}
          {viewingMine && oppProvenance.warn && (
            <div className="data-warn">
              <span className="data-warn-tag">{oppProvenance.tag}</span>
              <span>{oppProvenance.warn}</span>
            </div>
          )}
        </div>
      )}

      {viewingMine && !oppTeam && !sim && (
        <EmptyBox>Your matchup appears automatically once the ESPN sync runs — nothing to set up.</EmptyBox>
      )}

      {(leftRows.length > 0 || rightRows.length > 0) && (
        <div className="h2h">
          {pairs.map((p, idx) => {
            const A = sideData(p.mine, week, state);
            const B = sideData(p.theirs, week, state);
            const isLive = (A && A.isLive) || (B && B.isLive);
            // Both sides done -> the row sinks. Ten rows collapse into "here is
            // what's left" without reading a word.
            const isDone = A && B && A.isFinal && B.isFinal;
            // Slot divider: the position moves OUT of the row and becomes the
            // heading that groups it, so it is stated once per group instead of
            // twice per row.
            const newSlot = idx === 0 || pairs[idx - 1].slot !== p.slot;
            return (
              <React.Fragment key={p.key}>
                {newSlot && (
                  <div className="h2h-div">
                    <span style={{ color: SLOT_COLOR[p.slot] || "var(--text-dim)" }}>{p.slot}</span>
                    <i />
                  </div>
                )}
              <div className={`h2h-row ${isLive ? "islive" : ""} ${isDone ? "isdone" : ""}`}>
                <div className="h2h-l1">
                  <button
                    type="button"
                    className={`h2h-who ${A && A.isFinal ? "spent" : ""}`}
                    onClick={() => A && onOpenRow && onOpenRow(A.row)}
                    disabled={!A}
                    aria-label={A ? `Open ${A.row.name}` : "Empty slot"}
                  >
                    <Face row={A && A.row} />
                    <span className="h2h-nm">{A ? shortName(A.row.name) : "Empty"}</span>
                  </button>
                  <Proj d={A} />
                  {(() => {
                    const e = pairingEdge(A && A.worth, B && B.worth);
                    return (
                      <span className={`h2h-edge ${e.lead}`}>
                        {e.lead === "even" ? "EVEN" : `${e.lead === "mine" ? "◀ " : ""}${e.delta.toFixed(1)}${e.lead === "theirs" ? " ▶" : ""}`}
                      </span>
                    );
                  })()}
                  <Proj d={B} right />
                  <button
                    type="button"
                    className={`h2h-who r ${B && B.isFinal ? "spent" : ""}`}
                    onClick={() => B && onOpenRow && onOpenRow(B.row)}
                    disabled={!B}
                    aria-label={B ? `Open ${B.row.name}` : "Empty slot"}
                  >
                    <Face row={B && B.row} />
                    <span className="h2h-nm">{B ? shortName(B.row.name) : "Empty"}</span>
                  </button>
                </div>

                <div className="h2h-l2">
                  <span className={A && A.isFinal ? "spent" : ""}>
                    <Ident d={A} />
                  </span>
                  <span className={`r ${B && B.isFinal ? "spent" : ""}`}>
                    <Ident d={B} right />
                  </span>
                </div>

                <div className="h2h-l3">
                  <span>
                    {A ? `${A.when}${A.opp ? ` ${A.opp.at ? "@" : "vs"} ${A.opp.opp}` : ""}` : ""}
                    {/* Absent for 2 of 16 games in a real slate, so it renders
                        nothing rather than defaulting to an icon that isn't a
                        forecast. Indoor short-circuits it — the roof IS the
                        forecast. */}
                    {A && A.wx && (
                      <span className="h2h-wx" title={A.wx.label}>
                        {A.wx.icon}
                      </span>
                    )}
                  </span>
                  <span className="r">
                    {B && B.wx && (
                      <span className="h2h-wx" title={B.wx.label}>
                        {B.wx.icon}
                      </span>
                    )}
                    {B ? `${B.when}${B.opp ? ` ${B.opp.at ? "@" : "vs"} ${B.opp.opp}` : ""}` : ""}
                    {B ? " ›" : ""}
                  </span>
                </div>

                <div className="h2h-l4">
                  <Track d={A} />
                  <Track d={B} right />
                </div>

                <div className="h2h-l5">
                  <Chip d={A} />
                  <Chip d={B} right />
                </div>
              </div>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* The rest of the league, BELOW my own matchup. It used to eat the whole
          first screen and push my matchup a third of the way down. */}
      {leagueBoard.length > 0 && (
        <div className="gd-league">
          <div className="gd-league-k">Around the league</div>
          {leagueBoard.map((m, i) => (
            <button
              key={i}
              className={`gd-mini ${m.isMine ? "mine" : ""} ${viewIdx === i ? "active" : ""}`}
              onClick={() => setViewIdx(i)}
            >
              <span className="gd-mini-t">{m.awayName}</span>
              <span className="gd-mini-s">{m.awayScore}</span>
              <span className="gd-mini-d">–</span>
              <span className="gd-mini-s">{m.homeScore}</span>
              <span className="gd-mini-t r">{m.homeName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * One half of a head-to-head row. Projection sits on the INSIDE edge, next to
 * the slot badge, so the two numbers being compared are adjacent instead of a
 * screen apart.
 */
/**
 * Everything one side of a paired row needs, derived once.
 *
 * The three game states are the point of this screen. Before this they were
 * rendered almost identically — "Final" as 8px grey type in a corner — so you
 * could not tell at a glance which of your players were done. Each state now
 * gets its own number treatment, its own chip, and its own track.
 */
function sideData(row, week, state) {
  if (!row || !row.name) return null;
  const l = row.l || {};
  const status = l.status || "notStarted";
  const isFinal = status === "final";
  const isLive = status === "inProgress";
  const scored = Number.isFinite(l.scored) ? l.scored : 0;
  const live = liveProjection({
    pregame: row.proj,
    ifPlays: row.simProj ?? row.proj,
    scored: l.scored,
    pctRemaining: l.pctRemaining,
    status,
    playProb: row.playProb ?? 1,
  });
  const game = (state.espn && state.espn.games && row.team && state.espn.games[row.team]) || null;
  const opp = opponentOf((row.weeks && row.weeks[week] && row.weeks[week].opp) || scheduleOpp(state, row.team, week));
  const when = game && game.startTime ? kickoffLabel(game.startTime) : "";

  // FINAL shows ONE number: what he actually scored. A projection is dead once
  // the game ends — it is a fact now, not an estimate, and showing both invites
  // a comparison that no longer means anything.
  // LIVE shows the decayed projection with the pregame figure struck beneath.
  // PRE shows the projection alone.
  const value = isFinal ? scored : live;
  const was = isLive && Number.isFinite(row.proj) && live != null && Math.abs(row.proj - live) >= 0.1 ? row.proj : null;

  // Directional: a player fading and a player going off must not look the same.
  const dir = was == null ? "" : live > row.proj ? "up" : "down";

  // Every state carries a WORD, never colour alone — it has to survive a glance
  // in sunlight, and colour alone fails that and fails colour-blind readers.
  const chip = isFinal ? "FINAL" : isLive ? l.detail || "LIVE" : when || "PRE";

  return {
    row,
    status,
    isFinal,
    isLive,
    value,
    was,
    dir,
    chip,
    // What he is worth RIGHT NOW — the same number the row displays: banked
    // points once final, the live projection while football remains.
    worth: value,
    prog: isFinal ? 1 : isLive ? 1 - (l.pctRemaining ?? 1) : 0,
    when,
    opp,
    logo: teamLogoUrl(row.team),
    wx: wxGlyph(game),
  };
}

/**
 * Headshot on a board row. Falls back to the team logo when a player has no
 * espnId (defenses), and to nothing when neither resolves — never a broken
 * image, which reads as a bug rather than as missing data.
 */
const Face = ({ row }) => {
  const [failed, setFailed] = useState(false);
  if (!row) return <span className="h2h-face empty" />;
  const src = row.espnId ? headshotUrl(row.espnId) : teamLogoUrl(row.team);
  const team = teamOf(row.team);
  return (
    <span className="h2h-face" style={{ "--team": (team && team.primary) || "#2a3b57" }}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={row.espnId ? "" : "logo"} />
      ) : null}
    </span>
  );
};

const Proj = ({ d, right }) => {
  if (!d) return <span className="h2h-pr" />;
  return (
    <span className={`h2h-pr ${d.isFinal ? "isfinal" : d.dir} ${right ? "r" : ""}`}>
      {d.value != null ? d.value.toFixed(1) : "–"}
      {d.was != null && <small>{d.was.toFixed(1)}</small>}
    </span>
  );
};

const Ident = ({ d, right }) => {
  if (!d) return <span className={right ? "r" : ""} />;
  const { row } = d;
  return (
    <span className={right ? "r" : ""}>
      {row.status && <span className="h2h-inj">{row.status} · </span>}
      <span>{row.team}</span>
      {/* Labelled. "JAX (7)" gave no way to know 7 was the bye week — it reads
          as a rank, a jersey number or a projection. An unlabelled number on a
          screen full of numbers is worse than no number. */}
      {Number.isFinite(row.bye) ? ` · bye ${row.bye}` : ""}
    </span>
  );
};

const Chip = ({ d, right }) => {
  if (!d) return <span className={right ? "r" : ""} />;
  const kind = d.isFinal ? "final" : d.isLive ? "live" : "pre";
  return (
    <span className={right ? "r" : ""}>
      <b className={`h2h-chip ${kind}`}>{d.chip}</b>
    </span>
  );
};

/* The mirrored helmet tracks were unreadable — you couldn't tell which way
   they filled. A plain bar, filling from the OUTER edge inward on each side. */
const Track = ({ d, right }) => (
  <span className={`h2h-bar ${right ? "r" : ""}`}>
    <i
      className={d ? (d.isFinal ? "done" : d.isLive ? "on" : "") : ""}
      style={{ width: `${Math.round(Math.max(0, Math.min(1, d ? d.prog : 0)) * 100)}%` }}
    />
  </span>
);

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
