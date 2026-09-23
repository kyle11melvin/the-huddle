import { useState, useMemo } from "react";
import {
  playerAnalytics,
  rankDispersion,
  consensusLabel,
  pointDistribution,
  floorCeiling,
  propsProjection,
} from "../analytics.js";
import {
  lineupDistributions,
  simulateMatchupLive,
  simulateSwap,
  strategyAdvice,
  opponentDistributions,
  opponentSource,
  espnAgeMs,
  staleAfterMs,
  agoLabel,
  opponentLineups,
} from "../simulate.js";
import { LEAGUE_ROSTERS, MY_TEAM } from "../data/leagueRosters.js";
import { findLocation } from "../lineup.js";
import { weekLabel } from "../lineup.js";

const pct = (n) => `${Math.round(n * 100)}%`;

/**
 * The differentiator. FantasyPros tells you which player is better — the same
 * answer it gives everyone who owns him. This answers the question only your
 * league can: given who you're actually playing this week, which lineup wins
 * more often? Underdogs should buy variance, favourites should sell it, and
 * that inverts the "start the higher projection" advice surprisingly often.
 */
export default function StartSitLab({ state, week, onImport, onApplySwap, flash }) {
  const [picked, setPicked] = useState([]);
  // Opponent defaults to the real one from the ESPN schedule — override only
  // for what-if scenarios.
  const [oppTeam, setOppTeam] = useState(
    () => (state.matchups && state.matchups[week] && state.matchups[week].oppTeam) || ""
  );

  const roster = useMemo(
    () => Object.values(state.players).filter((p) => findLocation(state, p.id)?.zone !== "ir"),
    [state]
  );

  const toggle = (id) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 4 ? p : [...p, id]));

  /** Market-vs-model agreement: when Vegas props and ESPN's projection both
   *  exist, their gap IS the uncertainty signal — no expert pastes needed. */
  const sourceAgreement = (a, pos) => {
    if (!a || !Number.isFinite(a.proj) || a.proj <= 0) return null;
    // Partial lines (TD-only midweek) are not a market view of his game;
    // propsProjection returns null for them, and folds in a QB's INTs.
    const vegas = propsProjection(a, pos, state);
    if (!vegas) return null;
    const gap = Math.abs(vegas.pts - a.proj) / ((vegas.pts + a.proj) / 2);
    if (gap < 0.1) return { text: "Vegas & ESPN agree", tone: "good", gap };
    if (gap < 0.25) return { text: "Vegas & ESPN differ a bit", tone: "mid", gap };
    return { text: "market disagrees with ESPN", tone: "bad", gap };
  };

  const cards = picked.map((id) => {
    const p = state.players[id];
    const a = playerAnalytics(state, id, week);
    const disp = rankDispersion(a && a.expertRanks);
    const agree = sourceAgreement(a, p.pos);
    const dist = pointDistribution(p, week, state);
    return { p, a, disp, agree, dist, fc: floorCeiling(dist) };
  });

  // Opponent side of the simulation — the one canonical builder shared with
  // the optimizer and Gameday (live ESPN starters, injury-priced; static
  // roster + rank curve as the offline fallback).
  // Both opponent lineups. The primary number assumes they tidy up before
  // kickoff; the secondary is what they have set right now. Showing only the
  // blend would hide the fact that they might fix it — which is the
  // actionable part.
  const oppBoth = useMemo(() => opponentLineups(state, week, oppTeam), [state, week, oppTeam]);
  const oppDists = useMemo(
    () => opponentDistributions(state, week, oppTeam, "likely"),
    [state, week, oppTeam]
  );

  // Asked of the code that builds the numbers, not inferred from state.espn
  // being present — see opponentSource() in simulate.js for why that inference
  // is wrong in exactly the case that matters.
  const oppSource = useMemo(() => opponentSource(state, week, oppTeam), [state, week, oppTeam]);
  const espnAge = useMemo(() => espnAgeMs(state), [state]);
  // `mine` MUST be declared before anything that names it — including a
  // dependency array, which is evaluated at the useMemo call itself. This was
  // shipped with simActual above this line and threw
  // "Cannot access 'mine' before initialization" on first render, blanking
  // the Start/Sit tab.
  const mine = useMemo(() => lineupDistributions(state, state.lineup, week), [state, week]);
  // simulateMatchupLive, not simulateMatchup: a player whose game has finished
  // is a constant at what he actually scored, not a full-variance draw around
  // a projection the game already disproved. Before this the Lab showed the
  // opponent at 155.5 and Kyle at 43% when the real total was ~127 and he was
  // the favourite — it called the matchup the wrong way round. Pre-kickoff
  // every entry is `notStarted` and this is the pregame sim with extra steps.
  const sim = useMemo(
    () => (mine.dists.length && oppDists.length ? simulateMatchupLive(state, mine.dists, oppDists) : null),
    [state, mine, oppDists]
  );
  const simActual = useMemo(
    () => (oppBoth && oppBoth.differs && mine.dists.length ? simulateMatchupLive(state, mine.dists, oppBoth.actual) : null),
    [state, oppBoth, mine]
  );
  const advice = sim ? strategyAdvice(sim.winProb) : null;
  // Declared AFTER `sim`, deliberately. A const named above its declaration —
  // including inside a dependency array — is the temporal-dead-zone crash that
  // blanked this exact tab once already.
  const anyDone = !!sim && (sim.myLeft < mine.dists.length || sim.oppLeft < oppDists.length);
  // The provenance line is built HERE, below `sim`, because what it can
  // honestly claim depends on whether any game is done. Appending a caveat to
  // the pregame sentence was the first attempt and read as a contradiction in
  // a single paragraph: "both sides run on real ESPN projections ... finished
  // players are counted at what they actually scored".
  const labProvenance = (() => {
    if (oppSource === "estimated") {
      return "Opponent scores are estimated from expert ranks and are NOT injury-adjusted — a ruled-out starter still counts as healthy. Treat the number as directional and re-sync ESPN.";
    }
    const left = sim ? sim.myLeft + sim.oppLeft : 0;
    const basis = anyDone
      ? `Finished players count at exactly what they scored; the ${left} player${left === 1 ? "" : "s"} still to play run on real ESPN projections, with FantasyPros pastes adding expert-rank uncertainty.`
      : "Both sides run on real ESPN projections; FantasyPros pastes add expert-rank uncertainty on top.";
    if (oppSource === "live" && espnAge != null && espnAge > staleAfterMs(state)) {
      return `${basis} Last sync was ${agoLabel(espnAge)} ago — refresh before acting on a close call.`;
    }
    return basis;
  })();

  const starters = new Set();
  for (const key of Object.keys(state.lineup)) for (const id of state.lineup[key]) if (id) starters.add(id);

  // For each picked bench player, what would starting them do to your odds?
  const swaps = useMemo(() => {
    if (!sim || picked.length < 2) return [];
    const out = [];
    const benchPicked = picked.filter((id) => !starters.has(id));
    const startPicked = picked.filter((id) => starters.has(id));
    for (const inId of benchPicked) {
      for (const outId of startPicked) {
        const r = simulateSwap(state, week, oppDists, outId, inId);
        // Illegal pairs (a WR for your QB slot) are dropped, not rendered —
        // offering an Apply button for a move ESPN will reject is worse than
        // offering nothing.
        if (r && !r.illegal) out.push({ inId, outId, ...r });
      }
    }
    return out.sort((a, b) => b.delta - a.delta);
  }, [sim, picked, state, week, oppDists]);

  return (
    <div className="card lab">
      <div className="lab-head">
        <div>
          <div className="section-kicker">Decision engine</div>
          <div className="strength-title">Start / Sit Lab</div>
        </div>
      </div>

      <div className="lab-pick">
        <div className="field-label">Compare up to 4</div>
        {/* Grouped and labelled. Starters used to be marked by a 3px left
            border, which on a fully rounded chip drew an unexplained gold
            crescent on ten of twelve chips. */}
        {[
          ["Starters", roster.filter((p) => starters.has(p.id))],
          ["Bench", roster.filter((p) => !starters.has(p.id))],
        ].map(([label, group]) =>
          group.length ? (
            <div key={label} className="lab-group">
              <div className="lab-group-k">{label}</div>
              <div className="lab-chips">
                {group.map((p) => (
                  <button
                    key={p.id}
                    className={`lab-chip ${picked.includes(p.id) ? "on" : ""}`}
                    onClick={() => toggle(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null
        )}
      </div>

      {cards.length > 0 && (
        <div className="lab-grid">
          {cards.map(({ p, a, disp, agree, dist, fc }) => {
            const cl = consensusLabel(disp);
            return (
              <div key={p.id} className="lab-card">
                <div className="lab-name">{p.name}</div>
                <div className="lab-sub">
                  {p.pos} · {p.team}
                  {a && a.opponent ? ` · ${a.opponent}` : ""}
                </div>

                <div className="lab-stat">
                  <span>
                    Projection
                    {dist && dist.source && dist.source.startsWith("vegas props") && <span className="src-tag vegas">VEGAS</span>}
                  </span>
                  <strong>{dist ? dist.mean : "—"}</strong>
                </div>
                {fc && (
                  <div className="lab-range">
                    <span className="lab-floor">{fc.floor}</span>
                    <div className="lab-bar">
                      <div className="lab-bar-fill" />
                    </div>
                    <span className="lab-ceil">{fc.ceiling}</span>
                  </div>
                )}
                {/* The disagreement itself, never hidden behind the blend. */}
                {a && Number.isFinite(a.proj) && Number.isFinite(a.fpProj) && (
                  <div
                    className={`lab-sources ${Math.abs(a.proj - a.fpProj) >= 2 ? "split" : ""}`}
                    title={
                      dist && dist.source
                        ? `Blended: ${dist.source}`
                        : "Both projections, side by side"
                    }
                  >
                    <span>{a.proj} ESPN</span>
                    <span className="lab-sources-dot">·</span>
                    <span>{a.fpProj} FP</span>
                    {Math.abs(a.proj - a.fpProj) >= 2 && (
                      <span className="lab-sources-gap">{Math.abs(a.proj - a.fpProj).toFixed(1)} apart</span>
                    )}
                  </div>
                )}
                {a && Number.isFinite(a.matchupStars) && (
                  <div className="lab-stat">
                    <span>Matchup (FP)</span>
                    <strong title="Context only — FantasyPros already prices the matchup into its projection">
                      {"★".repeat(a.matchupStars)}
                      <span style={{ opacity: 0.3 }}>{"★".repeat(5 - a.matchupStars)}</span>
                    </strong>
                  </div>
                )}
                <div className="lab-stat">
                  <span>Vegas team total</span>
                  <strong>
                    {state.espn && Number.isFinite(state.espn.impliedTotals?.[p.team])
                      ? state.espn.impliedTotals[p.team]
                      : "—"}
                  </strong>
                </div>
                {dist && dist.playProb != null && dist.playProb < 1 && (
                  <div className="lab-stat">
                    <span>Chance he plays</span>
                    <strong>{Math.round(dist.playProb * 100)}%</strong>
                  </div>
                )}

                {!disp && agree && (
                  <div className="lab-consensus" title={`Vegas ${a.propsProj} vs ESPN ${a.proj}`}>
                    <span className={`cons-dot ${agree.tone}`} />
                    {agree.text}
                  </div>
                )}
                {disp && (
                  <>
                    <div className="lab-consensus">
                      <span className={`cons-dot ${cl.tone}`} />
                      {cl.text}
                    </div>
                    <div className="disp-row">
                      <span className="disp-end">#{disp.lo}</span>
                      <div className="disp-track">
                        <div
                          className={`disp-band ${cl.tone}`}
                          style={{
                            left: `${Math.min(90, (disp.lo / 100) * 100)}%`,
                            width: `${Math.max(4, Math.min(100 - (disp.lo / 100) * 100, ((disp.hi - disp.lo) / 100) * 100))}%`,
                          }}
                        />
                      </div>
                      <span className="disp-end">#{disp.hi}</span>
                    </div>
                    <div className="lab-note">
                      {disp.count} experts · median #{disp.median}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="modal-section-label">This week's opponent</div>
      <div className="field-row" style={{ marginTop: 0 }}>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>
          <select value={oppTeam} onChange={(e) => setOppTeam(e.target.value)}>
            <option value="">Who are you playing?</option>
            {LEAGUE_ROSTERS.filter((t) => t.team !== MY_TEAM).map((t) => (
              <option key={t.team} value={t.team}>
                {t.team}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!oppTeam && (
        <div className="lab-empty">Pick your opponent to simulate the matchup.</div>
      )}

      {oppTeam && !sim && (
        <div className="panel-warn">
          Not enough projections yet. Paste a FantasyPros comparison for your starters, and a ranking set from the
          Data panel so the opponent's players can be estimated.
        </div>
      )}

      {sim && (
        <div className="sim-box">
          <div className="sim-main">
            <div className="sim-prob">
              <div className={`sim-pct ${sim.winProb >= 0.5 ? "good" : "bad"}`}>{pct(sim.winProb)}</div>
              <div className="sim-label">win probability</div>
            </div>
            <div className="sim-detail">
              <div className="sim-row">
                <span>You</span>
                <strong>{sim.myProjFinal}</strong>
                <span className="sim-range">
                  {sim.myP10}–{sim.myP90}
                </span>
              </div>
              <div className="sim-row">
                <span>{oppTeam}</span>
                <strong>{sim.oppProjFinal}</strong>
                {/* The label has to stop saying "ESPN proj" the moment any
                    game is done: the number is then part banked fact and part
                    projection, and calling the whole thing a projection is the
                    same dishonesty as the old footer copy. */}
                <span className={`sim-range ${state.espn ? "" : "est"}`}>
                  {!state.espn ? "estimated" : anyDone ? "part final" : "ESPN proj"}
                </span>
              </div>
            </div>
          </div>
          {/* Both numbers, never just the blend — the gap IS the information. */}
          {simActual && oppBoth && oppBoth.differs && (
            <div className="sim-both">
              <div className="sim-both-row">
                <span className="sim-both-pct">{pct(sim.winProb)}</span>
                <span className="sim-both-label">against their <strong>likely</strong> lineup</span>
              </div>
              <div className="sim-both-row muted">
                <span className="sim-both-pct">{pct(simActual.winProb)}</span>
                <span className="sim-both-label">against what they have <strong>set right now</strong></span>
              </div>
              <div className="sim-both-note">
                {oppBoth.changes
                  .filter((c) => c.out)
                  .slice(0, 2)
                  .map((c, i) => (
                    <div key={i}>
                      {oppTeam} is starting <strong>{c.out.name}</strong>
                      {c.out.injuryStatus ? ` (${c.out.injuryStatus})` : ""}
                      {c.in ? (
                        <>
                          {" "}
                          over <strong>{c.in.name}</strong>
                        </>
                      ) : null}
                      .
                    </div>
                  ))}
                <div className="sim-both-hint">
                  {oppBoth.anyLocked
                    ? "Some of their players are locked in — those slots can't change now."
                    : "They can still fix this before kickoff, so the top number is the one to plan against."}
                </div>
              </div>
            </div>
          )}
          {advice && <div className={`sim-advice ${advice.mode}`}>{advice.text}</div>}

          {/* The verdict's action lives right here — no trip to the Roster tab. */}
          {swaps.length > 0 && swaps[0].delta > 0 && (
            <button
              className="btn-primary lab-apply"
              onClick={() => onApplySwap(swaps[0].outId, swaps[0].inId)}
            >
              ▶ Start {state.players[swaps[0].inId]?.name} over {state.players[swaps[0].outId]?.name} · +
              {(swaps[0].delta * 100).toFixed(1)}% win — Apply to ESPN
            </button>
          )}
          {swaps.length > 0 && swaps[0].delta <= 0 && (
            <div className="lab-note" style={{ marginTop: 10 }}>
              ✓ Your current starter is already the right call between these players.
            </div>
          )}

          <div className="sim-fine">
            {mine.missing.length > 0 && `No projection for ${mine.missing.join(", ")}. `}
            {labProvenance}
          </div>
        </div>
      )}

      {swaps.length > 0 && (
        <>
          <div className="modal-section-label">Swap impact</div>
          <div className="swap-list">
            {swaps.slice(0, 6).map((s) => {
              const inP = state.players[s.inId];
              const outP = state.players[s.outId];
              const up = s.delta > 0.002;
              const down = s.delta < -0.002;
              return (
                <div key={`${s.inId}-${s.outId}`} className={`swap-row ${up ? "up" : down ? "down" : "flat"}`}>
                  <span className="swap-text">
                    Start <strong>{inP?.name}</strong> over <span className="out-name">{outP?.name}</span>
                  </span>
                  <span className="swap-delta">
                    {up ? "+" : ""}
                    {(s.delta * 100).toFixed(1)}%
                  </span>
                  {up && (
                    <button className="chip-btn" onClick={() => onApplySwap(s.outId, s.inId)}>
                      Apply
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="lab-note" style={{ marginTop: 8 }}>
            Change in win probability, not points — that's why a lower-projected player can be the right start.
          </div>
        </>
      )}
    </div>
  );
}
