// ============================================================================
// Today — the answer to "am I OK?"
//
// That question used to take three tabs and three scrolls: Roster for who's
// hurt, Start/Sit for whether to swap, Gameday for the score. On a phone,
// under time pressure, before kickoff. This screen answers it above the fold
// and then gets out of the way.
//
// It ABSORBS Gameday rather than sitting beside it: Gameday was already a
// two-mode screen (liveEntryFor returns notStarted/inProgress/final, and
// simulateLive treats an all-notStarted lineup as the pre-kickoff case), so a
// separate Today would have duplicated that. One screen that changes shape
// when games start is what the code already wanted.
//
// Everything here is composition — buildAlerts, suggestLineup,
// opponentLineups, the existing Gameday board. No new engine.
// ============================================================================

import { useMemo, useState, useEffect } from "react";
import Gameday from "./Gameday.jsx";
import { SLOT_DEFS, weekLabel } from "../lineup.js";
import { effectiveStatus, suggestLineup } from "../analysis.js";
import { opponentDistributions, opponentLineups } from "../simulate.js";
import { anyGameLive } from "../espnSync.js";
import { formatCountdown } from "../timeUntil.js";
import { buildLockSweep } from "../lockSweep.js";
import { pointDistribution } from "../analytics.js";

const RISK_COPY = {
  out: "OUT — scores 0 unless swapped",
  bye: "on bye — scores 0",
  empty: "empty slot — nobody scoring",
  high: "doubtful",
  watch: "questionable",
};

const STATUS_COPY = {
  O: "is OUT",
  IR: "is on IR",
  BYE: "is on a bye",
  D: "is doubtful",
  Q: "is questionable",
};
const DEFINITE = new Set(["O", "IR", "BYE"]);


export default function Today({ state, week, onApplyMove, onSetLive, onSetOpponent, onRefresh, onOpenPlayer }) {
  // A clock, not a render loop: 30s granularity is plenty for a countdown
  // measured in hours and costs nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const oppDists = useMemo(
    () => opponentDistributions(state, week),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.espn, state.matchups, state.ecrIndex, state.schedule, week]
  );
  const oppBoth = useMemo(
    () => opponentLineups(state, week),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.espn, state.matchups, state.schedule, week]
  );
  const moves = useMemo(
    () => suggestLineup(state, week, oppDists),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.lineup, state.bench, state.players, state.analytics, state.byes, state.ecrIndex, state.espn, week, oppDists]
  );

  // Who in the STARTING lineup can't produce, or might not.
  const { blockers, doubts, emptySlots } = useMemo(() => {
    const blockers = [];
    const doubts = [];
    let emptySlots = 0;
    const byes = state.byes || {};
    for (const s of SLOT_DEFS) {
      for (const id of state.lineup[s.key] || []) {
        if (!id) {
          emptySlots++;
          continue;
        }
        const p = state.players[id];
        if (!p) continue;
        const st = effectiveStatus(p, week, byes);
        if (DEFINITE.has(st)) blockers.push({ p, st, slot: s.key });
        else if (st === "Q" || st === "D") doubts.push({ p, st, slot: s.key });
      }
    }
    return { blockers, doubts, emptySlots };
  }, [state.lineup, state.players, state.byes, week]);

  // Per-player lock triage — READ ONLY, it proposes nothing automatically.
  // Projections come through pointDistribution so replacement deltas are
  // injury- and bye-priced like every other number in the app.
  const sweep = useMemo(() => {
    const projections = {};
    const ids = [];
    for (const s of SLOT_DEFS) for (const id of state.lineup[s.key] || []) if (id) ids.push(id);
    for (const id of state.bench || []) if (id) ids.push(id);
    for (const id of ids) {
      const d = state.players[id] && pointDistribution(state.players[id], week, state);
      if (d) projections[id] = d.mean;
    }
    return buildLockSweep({
      roster: {
        lineup: state.lineup,
        bench: state.bench,
        players: state.players,
        byes: state.byes || {},
        week,
        projections,
      },
      games: (state.espn && state.espn.games) || {},
      now,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lineup, state.bench, state.players, state.byes, state.analytics, state.espn, state.projWeights, week, now]);

  // Next kickoff among starters whose game hasn't begun.
  const nextKick = useMemo(() => {
    const games = (state.espn && state.espn.games) || {};
    let best = null;
    for (const s of SLOT_DEFS) {
      for (const id of state.lineup[s.key] || []) {
        const p = id && state.players[id];
        const g = p && games[p.team];
        if (!g || g.state !== "pre" || !g.startTime) continue;
        const t = new Date(g.startTime).getTime();
        if (Number.isFinite(t) && (best == null || t < best.t)) best = { t, name: p.name };
      }
    }
    return best;
  }, [state.espn, state.lineup, state.players]);

  const live = anyGameLive(state);
  const topMove = moves.find((m) => m.mandatory) || moves[0] || null;
  // nextKick.t is already a timestamp — no ISO round-trip needed.
  const countdown = nextKick ? formatCountdown(nextKick.t - now) : null;

  const problems = blockers.length + emptySlots;
  const verdict = problems > 0 ? "bad" : topMove ? "warn" : "ok";
  const headline =
    problems > 0
      ? `${problems} thing${problems === 1 ? "" : "s"} to fix`
      : topMove
      ? "One move worth making"
      : doubts.length
      ? "Lineup is set — watch the injury tags"
      : "You're set";

  return (
    <div className="tab-panel" key="today">
      <div className={`today-card ${verdict}`}>
        <div className="today-head">
          <div>
            <div className="section-kicker">{live ? "Games are on" : weekLabel(week)}</div>
            <div className="today-headline">{headline}</div>
          </div>
          {countdown && !live && (
            <div className="today-clock" title={`Next kickoff: ${nextKick.name}`}>
              <span className="today-clock-num">{countdown}</span>
              <span className="today-clock-label">to first kickoff</span>
            </div>
          )}
        </div>

        {/* Definite zeros first — these are the ones that cost you the week. */}
        {blockers.length > 0 && (
          <div className="today-list">
            {blockers.map(({ p, st, slot }) => (
              <button key={p.id} className="today-row bad" onClick={() => onOpenPlayer(p.id)}>
                <span className="today-slot">{slot}</span>
                <span className="today-name">{p.name}</span>
                <span className="today-why">{STATUS_COPY[st]} — he will score 0</span>
              </button>
            ))}
          </div>
        )}
        {emptySlots > 0 && (
          <div className="today-list">
            <div className="today-row bad">
              <span className="today-slot">—</span>
              <span className="today-name">
                {emptySlots} empty starting slot{emptySlots === 1 ? "" : "s"}
              </span>
              <span className="today-why">nobody is scoring there</span>
            </div>
          </div>
        )}

        {/* The single highest-value action, with the button right on it. */}
        {topMove && (
          <div className="today-action">
            <div className="today-action-text">
              Start <strong>{topMove.inName}</strong>
              {topMove.outName ? (
                <>
                  {" "}
                  over <span className="out-name">{topMove.outName}</span>
                </>
              ) : null}
              <span className="today-action-why"> — {topMove.reason}</span>
            </div>
            <button className="btn-primary today-apply" onClick={() => onApplyMove(topMove)}>
              Apply
            </button>
          </div>
        )}

        {doubts.length > 0 && (
          <div className="today-doubts">
            {doubts.map(({ p, st }) => (
              <span key={p.id} className={`today-doubt ${st === "D" ? "d" : "q"}`}>
                {p.name} {STATUS_COPY[st]}
              </span>
            ))}
          </div>
        )}

        {/* Opponent realism, surfaced where the decision is made. */}
        {oppBoth && oppBoth.differs && (
          <div className="today-opp">
            {oppBoth.oppTeam} is starting{" "}
            {oppBoth.changes
              .filter((c) => c.out)
              .slice(0, 1)
              .map((c) => (
                <strong key={c.out.id}>
                  {c.out.name}
                  {c.out.injuryStatus ? ` (${c.out.injuryStatus})` : ""}
                </strong>
              ))}
            . The win probability below assumes they fix it before kickoff.
          </div>
        )}
      </div>

      {/* Lock sweep — per-player locks mean per-player deadlines. Read-only:
          every row is a decision left to the human, never an auto-swap. When
          everything is clear it still says so, in one quiet line. */}
      {sweep.length === 0 ? (
        <div className="locksweep-clear">Lock sweep: all 10 starters are clear — nothing needs a swap before kickoff.</div>
      ) : (
        <div className="locksweep-card">
          <div className="section-kicker">Lock sweep · {sweep.length} slot{sweep.length === 1 ? "" : "s"} to check</div>
          <div className="today-list">
            {sweep.map((a) => {
              const timing = a.kickoffUnknown
                ? "kickoff time unknown"
                : a.locksAt != null
                ? (() => {
                    const cd = formatCountdown(a.locksAt - now);
                    return cd ? `locks in ${cd}` : "locking now";
                  })()
                : null;
              const inner = (
                <>
                  <span className="today-slot">{a.slot}</span>
                  <span className="today-name">{a.playerName || "Empty slot"}</span>
                  <span className="today-why">
                    {RISK_COPY[a.risk]}
                    {timing ? ` · ${timing}` : ""}
                  </span>
                  <span className="locksweep-repl">
                    {a.replacements.length
                      ? `Bench: ${a.replacements
                          .map((r) => `${r.name}${r.delta != null ? ` (${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)})` : ""}`)
                          .join(" · ")}`
                      : "no eligible bench replacement"}
                  </span>
                </>
              );
              return a.playerId ? (
                <button key={a.id} className={`today-row locksweep-row ${a.risk}`} onClick={() => onOpenPlayer(a.playerId)}>
                  {inner}
                </button>
              ) : (
                <div key={a.id} className={`today-row locksweep-row ${a.risk}`}>
                  {inner}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* The board. Same component as before — one screen, two modes. */}
      <Gameday
        state={state}
        week={week}
        onSetLive={onSetLive}
        onSetOpponent={onSetOpponent}
        onRefresh={onRefresh}
      />
    </div>
  );
}
