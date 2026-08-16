import { useState, useMemo } from "react";
import {
  playerAnalytics,
  rankDispersion,
  consensusLabel,
  pointDistribution,
  floorCeiling,
} from "../analytics.js";
import { lineupDistributions, simulateMatchup, simulateSwap, strategyAdvice } from "../simulate.js";
import { LEAGUE_ROSTERS, MY_TEAM } from "../data/leagueRosters.js";
import { espnTeamRoster } from "../espnSync.js";
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
  const sourceAgreement = (a) => {
    if (!a || !Number.isFinite(a.propsProj) || !Number.isFinite(a.proj) || a.proj <= 0) return null;
    const gap = Math.abs(a.propsProj - a.proj) / ((a.propsProj + a.proj) / 2);
    if (gap < 0.1) return { text: "Vegas & ESPN agree", tone: "good", gap };
    if (gap < 0.25) return { text: "Vegas & ESPN differ a bit", tone: "mid", gap };
    return { text: "market disagrees with ESPN", tone: "bad", gap };
  };

  const cards = picked.map((id) => {
    const p = state.players[id];
    const a = playerAnalytics(state, id, week);
    const disp = rankDispersion(a && a.expertRanks);
    const agree = sourceAgreement(a);
    const dist = pointDistribution(p, week, state);
    return { p, a, disp, agree, dist, fc: floorCeiling(dist) };
  });

  // Opponent side of the simulation. Their roster is known; their projections
  // are not until ESPN sync lands, so this stays honest about what's missing.
  const oppRoster = useMemo(
    () => LEAGUE_ROSTERS.find((t) => t.team === oppTeam),
    [oppTeam]
  );

  const oppDists = useMemo(() => {
    const CVS = { QB: 0.32, RB: 0.5, WR: 0.58, TE: 0.6, K: 0.42, "D/ST": 0.72 };
    // Real ESPN projections for their current starters, when synced.
    const live = espnTeamRoster(state, oppTeam);
    if (live) {
      return live
        .filter((e) => e.slot !== "BE" && e.slot !== "IR" && Number.isFinite(e.proj) && e.proj > 0)
        .map((e) => ({
          id: e.name.toLowerCase().replace(/[^a-z]/g, ""),
          name: e.name,
          mean: e.proj,
          sd: e.proj * (CVS[e.pos] ?? 0.55),
        }));
    }
    if (!oppRoster) return [];
    const out = [];
    for (const [name, , pos] of oppRoster.starters) {
      const k = name.toLowerCase().replace(/[^a-z]/g, "");
      const rank = state.ecrIndex ? state.ecrIndex[k] : null;
      if (rank == null) continue;
      // Rough points-from-rank curve, only used to give the simulation an
      // opponent at all. Flagged as an estimate everywhere it surfaces.
      const mean = Math.max(4, 22 - Math.log2(Math.max(1, rank)) * 3.1);
      const cv = CVS[pos] ?? 0.55;
      out.push({ id: k, name, mean, sd: mean * cv });
    }
    return out;
  }, [state, oppTeam, oppRoster]);

  const mine = useMemo(() => lineupDistributions(state, state.lineup, week), [state, week]);
  const sim = useMemo(
    () => (mine.dists.length && oppDists.length ? simulateMatchup(mine.dists, oppDists) : null),
    [mine, oppDists]
  );
  const advice = sim ? strategyAdvice(sim.winProb) : null;

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
        if (r) out.push({ inId, outId, ...r });
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
        <div className="lab-chips">
          {roster.map((p) => (
            <button
              key={p.id}
              className={`lab-chip ${picked.includes(p.id) ? "on" : ""} ${starters.has(p.id) ? "starter" : ""}`}
              onClick={() => toggle(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
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
                    {dist && dist.source === "vegas props" && <span className="src-tag vegas">VEGAS</span>}
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
                <div className="lab-stat">
                  <span>Matchup</span>
                  <strong>{a && a.matchupRating != null ? `${a.matchupRating}/10` : "—"}</strong>
                </div>
                <div className="lab-stat">
                  <span>Game O/U</span>
                  <strong>{a && a.ou && a.ou.gameTotal != null ? a.ou.gameTotal : "—"}</strong>
                </div>

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
                <strong>{sim.myMean}</strong>
                <span className="sim-range">
                  {sim.myP10}–{sim.myP90}
                </span>
              </div>
              <div className="sim-row">
                <span>{oppTeam}</span>
                <strong>{sim.oppMean}</strong>
                <span className={`sim-range ${state.espn ? "" : "est"}`}>
                  {state.espn ? "ESPN proj" : "estimated"}
                </span>
              </div>
            </div>
          </div>
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
            {state.espn
              ? "Both sides run on real ESPN projections; FantasyPros pastes add expert-rank uncertainty on top."
              : "Opponent scores are estimated from expert ranks until ESPN sync is connected — treat the number as directional."}
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
