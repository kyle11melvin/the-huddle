import { useState, useMemo } from "react";
import { TEAMS } from "../data/teams.js";
import { parseRankings, parseByes, planEcrUpdates, buildEcrIndex } from "../importer.js";
import { parseProps, leagueScoring } from "../props.js";
import { shareUrl, decodeShare } from "../share.js";
import { POSITIONS } from "../lineup.js";

// Bye weeks left this list on purpose: they auto-fill from the NFL schedule
// feed now, so there is nothing manual left to do there.
const SECTIONS = [
  ["share", "Share"],
  ["vegas", "Vegas"],
  ["rankings", "Rankings"],
];

export default function DataPanel({
  state,
  onClose,
  onApplyEcr,
  onApplyByes,
  onSetBye,
  onImportTeam,
  onApplyProps,
  flash,
  link: syncLink,
  syncStatus,
  syncError,
  onGoLive,
  onStopLive,
  onJoinTeam,
  onRefreshLive,
  liveUrl,
}) {
  const [section, setSection] = useState("share");

  // ---- share ----
  const [copied, setCopied] = useState(false);
  const [copiedWhich, setCopiedWhich] = useState("");
  const [importLink, setImportLink] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const link = useMemo(() => {
    try {
      return shareUrl(state);
    } catch {
      return "";
    }
  }, [state]);

  const copyText = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedWhich(which);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      flash("Couldn't copy — select the text and copy manually.");
    }
  };
  const copy = () => copyText(link, "snapshot");

  const doGoLive = async () => {
    setBusy(true);
    setErr("");
    const res = await onGoLive();
    setBusy(false);
    if (res?.error) setErr(res.error);
  };

  const doJoin = async () => {
    setBusy(true);
    setErr("");
    const res = await onJoinTeam(joinCode);
    setBusy(false);
    if (res?.error) setErr(res.error);
    else setJoinCode("");
  };

  const doImportLink = () => {
    const m = /[#&]team=([A-Za-z0-9\-_]+)/.exec(importLink.trim()) || [null, importLink.trim()];
    try {
      const incoming = decodeShare(m[1]);
      onImportTeam(incoming);
    } catch {
      flash("That doesn't look like a valid Huddle share link.");
    }
  };

  // ---- rankings ----
  const [rankText, setRankText] = useState("");
  const [rankPos, setRankPos] = useState("");
  const preview = useMemo(() => {
    if (!rankText.trim()) return null;
    const { rows, skipped } = parseRankings(rankText, rankPos);
    const roster = Object.values(state.players);
    const plan = planEcrUpdates(rows, roster);
    return { rows, skipped, ...plan };
  }, [rankText, rankPos, state.players]);

  // ---- vegas props ----
  const [propsText, setPropsText] = useState("");
  const propsPreview = useMemo(() => {
    if (!propsText.trim()) return null;
    return parseProps(propsText, Object.values(state.players), leagueScoring(state));
  }, [propsText, state]);

  // ---- byes ----
  const [byeText, setByeText] = useState("");
  const byePreview = useMemo(() => (byeText.trim() ? parseByes(byeText) : null), [byeText]);
  const byes = state.byes || {};
  const byeCount = Object.keys(byes).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal data-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <div className="sheet-kicker">Data</div>
            <div className="sheet-title">Import &amp; Share</div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="panel-tabs">
          {SECTIONS.map(([k, label]) => (
            <button key={k} className={`panel-tab ${section === k ? "active" : ""}`} onClick={() => setSection(k)}>
              {label}
            </button>
          ))}
        </div>

        <div className="sheet-body">
          {section === "share" && (
            <>
              {!syncLink && (
                <>
                  <div className="live-hero">
                    <div className="live-dot off" />
                    <div>
                      <div className="live-title">Live sync is off</div>
                      <div className="live-sub">Your team lives only on this device.</div>
                    </div>
                  </div>
                  <p className="panel-note">
                    Turn it on and you get a <strong>short team code</strong>. Anyone with the code sees your team as
                    it is right now — not a frozen copy — and your own phone and laptop stay in step. Only this device
                    can make changes.
                  </p>
                  <button className="btn-primary" onClick={doGoLive} disabled={busy}>
                    {busy ? "Publishing…" : "⚡ Turn on live sync"}
                  </button>
                  {err && <div className="form-error">{err}</div>}
                </>
              )}

              {syncLink && syncLink.mode === "owner" && (
                <>
                  <div className="live-hero">
                    <div className={`live-dot ${syncStatus === "error" ? "bad" : "on"}`} />
                    <div>
                      <div className="live-title">
                        {syncStatus === "error" ? "Sync error" : syncStatus === "saving" ? "Syncing…" : "Live"}
                      </div>
                      <div className="live-sub">
                        {syncError || "Every change publishes automatically."}
                      </div>
                    </div>
                  </div>

                  <div className="modal-section-label">Your team code</div>
                  <div className="code-box">
                    <span className="team-code">{syncLink.id}</span>
                    <button className="btn-secondary" onClick={() => copyText(syncLink.id, "code")}>
                      {copied && copiedWhich === "code" ? "Copied ✓" : "Copy code"}
                    </button>
                  </div>

                  <div className="modal-section-label">Link for the league</div>
                  <div className="share-box">
                    <input readOnly value={liveUrl} onFocus={(e) => e.target.select()} />
                    <button className="btn-primary" onClick={() => copyText(liveUrl, "live")}>
                      {copied && copiedWhich === "live" ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                  <div className="panel-meta">Read-only for everyone else · {liveUrl.length} chars</div>

                  <p className="panel-note" style={{ marginTop: 18 }}>
                    Keep this device — it holds the only key that can write to this code. Turning sync off leaves the
                    published copy in place but stops updating it.
                  </p>
                  <button className="btn-danger-ghost" style={{ marginLeft: 0 }} onClick={onStopLive}>
                    Turn off live sync
                  </button>
                </>
              )}

              {syncLink && syncLink.mode === "viewer" && (
                <>
                  <div className="live-hero">
                    <div className="live-dot follow" />
                    <div>
                      <div className="live-title">Following team {syncLink.id}</div>
                      <div className="live-sub">Updates when you return to this tab.</div>
                    </div>
                  </div>
                  <p className="panel-note">
                    You're viewing someone else's team. Edits you make here stay on your device and never reach them.
                  </p>
                  <div className="claim-actions" style={{ borderTop: "none", paddingTop: 0 }}>
                    <button className="btn-primary" onClick={onRefreshLive}>
                      Refresh now
                    </button>
                    <button className="btn-secondary" onClick={onStopLive}>
                      Stop following
                    </button>
                  </div>
                </>
              )}

              {!syncLink && (
                <>
                  <div className="modal-section-label">Follow someone's team</div>
                  <div className="code-box">
                    <input
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value)}
                      placeholder="team code or link"
                    />
                    <button className="btn-secondary" onClick={doJoin} disabled={busy || !joinCode.trim()}>
                      Follow
                    </button>
                  </div>
                </>
              )}

              <div className="modal-section-label">Snapshot link (no sync)</div>
              <p className="panel-note">
                Carries the whole team inside the URL — works without live sync, but freezes at the moment you copy
                it.
              </p>
              <div className="share-box">
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
                <button className="btn-secondary" onClick={copy}>
                  {copied && copiedWhich === "snapshot" ? "Copied ✓" : "Copy"}
                </button>
              </div>
              <div className="panel-meta">{Math.round(link.length / 1024)} KB link</div>

              <div className="modal-section-label">Load a snapshot</div>
              <textarea
                rows={2}
                value={importLink}
                onChange={(e) => setImportLink(e.target.value)}
                placeholder="Paste a huddle snapshot link…"
              />
              <button
                className="btn-secondary"
                style={{ marginTop: 10 }}
                onClick={doImportLink}
                disabled={!importLink.trim()}
              >
                Load team
              </button>
            </>
          )}

          {section === "vegas" && (
            <>
              <p className="panel-note">
                <strong>Prop lines outrank every projection in this app.</strong> They're the only numbers with money
                behind them — a mispriced line gets corrected by professionals within hours; a wrong "expert" loses
                nothing. Paste props from your sportsbook (or FantasyPros' odds page): player name on a line, then
                markets like <code>Rec Yds 69.5</code>, <code>Receptions 5.5</code>, <code>Anytime TD +120</code>.
                Converted to full-PPR points automatically, TD odds de-vigged.
              </p>
              <textarea
                rows={7}
                value={propsText}
                onChange={(e) => setPropsText(e.target.value)}
                placeholder={"Tee Higgins\nReceiving Yards 69.5\nReceptions 5.5\nAnytime TD +120\n\nBijan Robinson\nRush Yds 88.5\nAnytime TD -145"}
              />
              {propsPreview && (
                <div className="import-preview">
                  <div className="import-stat-row">
                    <span className="import-stat ok">
                      <strong>{propsPreview.players.length}</strong> players with lines
                    </span>
                  </div>
                  {propsPreview.players.map(({ player, computed }) => (
                    <div key={player.id} className="props-block">
                      <div className="import-row">
                        <span className="import-name">{player.name}</span>
                        <span className="import-change">
                          <span className="to">{computed.points} pts</span>
                        </span>
                      </div>
                      <div className="props-parts">
                        {computed.parts.map(([label, pts], i) => (
                          <span key={i} className="props-part">
                            {label} → {pts}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {propsPreview.players.length === 0 && (
                    <div className="panel-warn">
                      No players matched — make sure each player's name is on its own line (or starts the line), and
                      that they're on your roster.
                    </div>
                  )}
                  <button
                    className="btn-primary"
                    style={{ marginTop: 14 }}
                    disabled={!propsPreview.players.length}
                    onClick={() => {
                      onApplyProps(propsPreview.players);
                      setPropsText("");
                    }}
                  >
                    Use these {propsPreview.players.length} Vegas projections
                  </button>
                </div>
              )}
              <div className="panel-meta" style={{ marginTop: 12 }}>
                Game totals &amp; spreads already auto-apply from ESPN's odds feed — pasting player props here sharpens
                individual players on top. Lines firm up toward kickoff; a Sunday-morning re-paste beats a Tuesday one.
              </div>
            </>
          )}

          {section === "rankings" && (
            <>
              <p className="panel-note">
                <strong>Optional now</strong> — rankings auto-derive from ESPN projections since the league link went
                live. Pasting FantasyPros ranks still adds value: expert opinion sometimes disagrees with ESPN's
                model, and pasted ranks override the automatic ones name-by-name. Format: <code>rank name team</code>.
              </p>
              <div className="field-row" style={{ marginTop: 0 }}>
                <label className="field" style={{ width: 150 }}>
                  <span className="field-label">Position (if list omits it)</span>
                  <select value={rankPos} onChange={(e) => setRankPos(e.target.value)}>
                    <option value="">Auto-detect</option>
                    {POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <textarea
                rows={8}
                style={{ marginTop: 12 }}
                value={rankText}
                onChange={(e) => setRankText(e.target.value)}
                placeholder={"11  T. Lawrence  JAC\n14  J. Goff  DET\n15  P. Mahomes II  KC"}
              />

              {preview && (
                <div className="import-preview">
                  <div className="import-stat-row">
                    <span className="import-stat">
                      <strong>{preview.rows.length}</strong> parsed
                    </span>
                    <span className="import-stat ok">
                      <strong>{preview.updates.length}</strong> of your players update
                    </span>
                    <span className="import-stat dim">
                      <strong>{preview.unmatched.length}</strong> not on your roster
                    </span>
                    {preview.ambiguous.length > 0 && (
                      <span className="import-stat warn">
                        <strong>{preview.ambiguous.length}</strong> ambiguous
                      </span>
                    )}
                  </div>
                  {preview.updates.length > 0 && (
                    <div className="import-list">
                      {preview.updates.slice(0, 12).map((u) => (
                        <div key={u.id} className="import-row">
                          <span className="import-name">{u.name}</span>
                          <span className="import-change">
                            <span className="from">{u.from}</span> → <span className="to">{u.to}</span>
                          </span>
                        </div>
                      ))}
                      {preview.updates.length > 12 && (
                        <div className="import-more">+{preview.updates.length - 12} more</div>
                      )}
                    </div>
                  )}
                  {preview.ambiguous.length > 0 && (
                    <div className="panel-warn">
                      Skipping {preview.ambiguous.map((a) => a.name).join(", ")} — more than one player on your roster
                      matches that surname and initial.
                    </div>
                  )}
                  <button
                    className="btn-primary"
                    style={{ marginTop: 14 }}
                    disabled={!preview.rows.length}
                    onClick={() => {
                      onApplyEcr(preview.updates, buildEcrIndex(preview.rows, state.ecrIndex));
                      setRankText("");
                    }}
                  >
                    Apply {preview.updates.length} update{preview.updates.length === 1 ? "" : "s"} + index{" "}
                    {preview.rows.length}
                  </button>
                </div>
              )}
            </>
          )}

          {section === "byes" && (
            <>
              <p className="panel-note">
                <strong>Bye weeks start empty on purpose.</strong> I don't have a verified 2026 bye schedule, and a
                guessed one would quietly tell you a benched player is fine to start. Paste the real table or fill in
                the teams you care about — once set, players auto-flag <strong>BYE</strong> on that week and the
                lineup checker catches them.
              </p>
              <textarea
                rows={5}
                value={byeText}
                onChange={(e) => setByeText(e.target.value)}
                placeholder={"ARI 8   ATL 5   BAL 7   BUF 7 …"}
              />
              {byePreview && (
                <div className="import-preview">
                  <div className="import-stat-row">
                    <span className="import-stat ok">
                      <strong>{byePreview.found}</strong> teams found
                    </span>
                  </div>
                  <button
                    className="btn-primary"
                    style={{ marginTop: 12 }}
                    disabled={!byePreview.found}
                    onClick={() => {
                      onApplyByes(byePreview.byes);
                      setByeText("");
                    }}
                  >
                    Apply {byePreview.found} bye week{byePreview.found === 1 ? "" : "s"}
                  </button>
                </div>
              )}

              <div className="modal-section-label">
                Set manually · {byeCount}/{Object.keys(TEAMS).length} entered
              </div>
              <div className="bye-grid">
                {Object.keys(TEAMS)
                  .sort()
                  .map((abbr) => (
                    <label key={abbr} className={`bye-cell ${byes[abbr] ? "set" : ""}`}>
                      <span className="bye-team">{abbr}</span>
                      <input
                        value={byes[abbr] || ""}
                        inputMode="numeric"
                        placeholder="—"
                        onChange={(e) => onSetBye(abbr, e.target.value)}
                      />
                    </label>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
