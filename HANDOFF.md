# The Huddle — handoff

Written for whoever picks this up next (Cowork reviews, Claude Code implements).
State as of commit `2a602b8`, Aug 18 2026. **Opener is Sept 9 — 22 days.**

---

## 1. Orientation

| | |
|---|---|
| Repo | `github.com/kyle11melvin/the-huddle` (public — safe, endpoints are token-gated) |
| Live | `the-huddle-hq.vercel.app` |
| Vercel | project `brcg/the-huddle`, Hobby |
| Stack | React 18 + Vite, serverless routes in `api/`, Vercel Blob for share snapshots |
| Size | ~13,100 lines. `App.jsx` is 3,474 of them. |
| Tests | `npm test` → `scripts/sanity.mjs`, **122 assertions**, zero dependencies |
| League | 10-team ESPN, full PPR, **6-pt passing TDs, −3 INT, 1pt/5 rush att** (verified from `mSettings`, not assumed) |

### Deploys are manual — this trips everyone up

The repo is **not** connected to Vercel's Git integration. **Pushing to GitHub does not deploy.** Both commands need `npx` and `--yes`:

```bash
npx vercel deploy --prod --yes --force
npx vercel alias set <deployment-url> the-huddle-hq.vercel.app
```

So the Vercel Deployments tab is not an accurate history, and code can sit pushed-but-undeployed. `--force` matters: without it Vercel dedupes and may alias a stale build.

Git pushes also hang under the default credential helper. Use:

```bash
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main
```

---

## 2. Two landmines — read before touching either file

### ⚠️ `/api/espn` must never use `s-maxage`

`api/espn.js` sets `Cache-Control: private, max-age=30` **deliberately**. It was `s-maxage` (a shared-CDN directive). Vercel's edge keys on URL alone, so the CDN would replay an authorized 200 to an unauthenticated caller **without ever invoking the function** — the token check looks correct in source and is bypassable in production.

The asymmetry with its neighbours is intentional: `/api/odds`, `/api/schedule` and `/api/news` correctly use `s-maxage` because they return nothing private and have no token gate. Anyone "harmonising" these silently voids the auth.

**Both directions are pinned by tests** (`sanity.mjs` §22) — the guard greps the source, because the threat is someone editing a string.

### ⚠️ Share links: the team code IS the password

`api/team.js` is deliberately outside the token scheme, because share links must work for league-mates with no token.
- **GET is fully open.** Any correctly-formatted id returns that team's entire state.
- **PUT** requires `x-huddle-key` (≥8 chars) and is **trust-on-first-use**: whoever PUTs first to an unclaimed id owns it permanently. Exposure is squatting, not arbitrary writes. Low urgency.

---

## 3. Auth model

- `x-huddle-token` header, checked with `crypto.timingSafeEqual` in `api/_auth.js`, **fails closed** if the env var is missing. Gate sits before any env read, body parse or ESPN fetch.
- `HUDDLE_WRITE_TOKEN` (Sensitive) + `ALLOWED_ORIGINS` in Vercel env.
- Client reads the token from `localStorage` via `src/authToken.js` — **never** `import.meta.env` (Vite inlines `VITE_*` into the public bundle).
- Token must be pasted **per device**: Import & share → Huddle write token.

Health check, must print `401`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://the-huddle-hq.vercel.app/api/espn
```

---

## 4. The engine, end to end

Data flows in one direction. Understanding this chain explains most of the codebase.

```
SOURCES                    →  pointDistribution()  →  simulate.js      →  analysis.js
vegas props (api/odds)        the one place a          Monte Carlo,        suggestLineup,
ESPN proj (api/espn)          player becomes a         20k runs,           leagueStrength,
FantasyPros PROJ. FPTS        {mean, sd, playProb}     correlated          waiver fit
season average
```

**`pointDistribution` (`src/analytics.js`) is the single choke point.** Everything downstream — the optimizer, the Lab, Gameday, roster rows — reads it. Fixes belong here, not in the five consumers. Precedence:

1. **Vegas props** — money-backed, outranks opinion
2. **ESPN + FantasyPros blended** when both exist (see §5)
3. Either alone
4. Season average

It also prices, in this order: **byes** (→ 0), **injury** as a bimodal mixture (`PLAY_PROB` Q 0.77 / D 0.25, *not* a points penalty), and a ±12% Vegas game-line tilt on non-props sources.

**`simulate.js`** draws lognormal marginals through a Gaussian copula — QB↔his receivers correlate, same-game players share a script, D/ST anti-correlates with the opposing offense. `SCAN_RUNS` stays at **8000**: measured, at 4000 a win-prob delta drifts up to 2.0% against a 1% reporting threshold, so recommendations would flicker. Common random numbers don't quiet it because swapping a player changes the factor-key set.

**`bestLineupFrom` (`src/lineup.js`)** is the shared optimizer. Both sides of a matchup use it — see §5.

---

## 5. What shipped since the review baseline (`6ed2a39` → `2a602b8`)

16 commits. Grouped by theme:

**Security & budget** (`9b6e8ea`) — endpoint auth, origin allowlist, fetch timeouts everywhere, query-param guards on `/api/odds` and `/api/schedule` (unknown params were busting the CDN cache key and draining the Odds API tier).

**Silent data corruption** (`fb14dc3`) — share links no longer overwrite your own saved team; the schedule sweep requires all 18 weeks (one failed fetch used to fake a permanent league-wide bye); auto and manual byes split into separate maps; IR overflow no longer deletes players; `migrate` no longer deletes orphans.

**Engine correctness** (`2d3ed0d`, `d23de87`) — optimizer no longer compares two incompatible score scales; the props parser no longer reads "Fantasy Points" as interceptions (was scoring a WR at **−25.6**); ESPN zero-projections stored rather than discarded; byes zero out in `pointDistribution` so all five consumers are correct at once; the Lab can't offer illegal swaps; ties no longer report as losses; kickoff locks fail **closed**; FAAB revert is a true inverse; duplicate names can't merge.

**Performance** (`47d8f0f`) — keystroke cost in the Opponent field **191ms → 1.3ms** (measured in-browser); Gameday sim memoized; `Row` hoisted so rows stop remounting and the fallback input keeps focus; **the 120s live poll now actually fires** — it depended on `[state, onRefresh]`, both of which churn, so it was torn down before firing every time.

**Touch** (`386404a`, `d368bab`) — tap-to-move is first-class on a coarse pointer (52×44 MOVE button, bottom-sheet MoveSheet). An abandoned touch drag used to leave the auto-scroll loop running forever, driving the page to a scroll boundary and pinning it; now watchdogged and torn down on touch-native events.

**Credibility** (`54fc994`, `fcf8635`, `275c0a3`) — bids priced in **points gated by demand** (a 1%-rostered player was being priced at $23, a quarter of the season budget; now $3); every rank carries its provenance (`ESPN` / `FP` / `ECR`); the importer matcher went **11/16 → 16/16** on the real roster; expert projections import and blend.

**Product** (`9edc6be`, `95af72e`, `2a602b8`) — Intel reordered so fixed-value content outranks the feed; **calibration ledger** capturing from week 1; **Today** (Command Center) as the default tab, absorbing Gameday; error boundary with a recovery hatch.

### Three design decisions worth not re-litigating

**Blend, don't rank, the two projection sources.** On the real roster five of six players agreed within 0.7 points and one disagreed by 4. A precedence rule discards the agreement on the five to resolve the one — but on the sixth the *disagreement is the finding*. So means blend and `sd` widens by the gap.

**The blend weight is 50/50 and labelled an assumption, in the UI, in words.** With no track record there is no measured variance to weight by, and a fabricated inverse-variance number would be a guess wearing a lab coat. `calibration.projWeights()` refits from observed mean absolute error once **60** both-source graded rows exist, flipping the label to "measured". This is the house style: *a number that looks derived but is a guess must say so.*

**Opponent realism.** Every win probability used to be computed against whatever slots the opponent happened to have set, stale OUT players included. `opponentLineups()` now returns **both** their actual and their likely lineup, and the UI shows both — "58% against their likely lineup, 71% against what they have set" tells you they might fix it, which is actionable. Players whose game has kicked off are pinned to reality, so the two converge through Sunday.

---

## 6. Verified vs unverified — important

**Verified in a real browser:** auth returns 401 unauthenticated; param guards 400; the keystroke and drag numbers; the touch flow at 375×812 (Chrome device emulation); Today's verdict/countdown/action against an injected problem lineup; the error boundary catching and preserving the token; the schedule endpoint returning 18/18 weeks.

**NOT verified, needs a real Sunday or Kyle's device:**
- The 120s live poll actually firing (needs a live game — watch "Last synced" advance on its own)
- Gameday fallback-mode focus retention (needs ESPN disconnected)
- Drag easing *feel* on a real iPhone (tuning knobs: 80px edge zone, 20px/frame cap in `src/dragScroll.js`)
- **iOS Safari specifically** — touch work was verified under Chrome emulation, not on iOS
- Today on Kyle's real roster (only ever seen against fixtures)
- The kickoff countdown — `startTime` only arrives on the next ESPN sync

**Inert until Kyle acts:** the projection blend does nothing until he pastes a FantasyPros **PROJ. FPTS** export. The calibration ledger captures nothing until real games are played.

---

## 7. Open work, ranked

1. **Rank source mixing** — `positionNeeds` averages ranks whose sources differ (`ESPN` projection-order vs pasted `FP` consensus vs seed `ECR`). Kyle's call, and it's right: convert to **projected points** rather than patching the mixing, which makes the question moot. `upgradeRanks` no longer feeds the bid, so blast radius is now the watchlist tier and the "+11 better" copy only.
2. **Swing meter** (plan Step 3) — per-player win-probability leverage. Retain per-run draws in `simulateMatchup` and regress. ⚠️ 20k × ~20 players ≈ 400k floats; must not run per render or it reintroduces the freeze just fixed.
3. **Playoff odds / ROS sim** (plan Step 4) — **unblocked**: `matchups: 5` confirmed the filter, the full season is in `data.schedule`. Still needs `record.overall.pointsFor/pointsAgainst` exposed (currently dropped at `api/espn.js`). Deliberately a **Week 2** target; week-1 playoff odds ≈ preseason priors.
4. **Code health** — `App.jsx` 3,474 lines (13-step extraction plan in `the-huddle-review.md`, steps 1–6 mechanical, ~1,170 lines). No README, no lint config, no CI. `index.css` ~3,100 lines with ~37 classes styled across multiple layers.
5. **`api/team.js` first-PUT squatting** — low urgency, see §2.

---

## 7b. Auto-grading the Game Log — decided, not yet built

Deliberately waiting for real games. The design is settled; don't re-open it.

Today every Game Log outcome is marked RIGHT/WRONG by hand, which is the main
reason the feature gets abandoned by Week 5. The app knows the actual scores,
so most calls can grade themselves. Three constraints, all load-bearing:

**Grade on Δ win probability at decision time, not points.** Starting the
high-floor player when you're favoured is correct process even in the weeks it
loses. Grading on raw points would mark you wrong for playing it right, and
the calibration data would then teach you to chase outcomes — the opposite of
what the log is for.

**The two calibration systems must stay separate.** `src/calibration.js`
grades the MODEL against actual results; `lineup.js callCalibration` grades
the USER against the model. Process-grading is only defensible because
something independent is checking whether the model deserves to be the judge.
Merge them and the loop is circular: a biased model would certify its own
advice forever and never be shown wrong. Both files now carry this warning in
their headers — keep it there.

**Store the raw point outcome alongside the process grade**, even though the
UI shows the process one. It costs nothing, and if the ledger later reveals
the model is biased, past calls need re-examining against a judge that has
since been shown untrustworthy. Throwing the points away makes that
impossible.

Leave genuinely subjective calls (a trade, a stash) to manual grading —
"did it work" isn't a point total for those.

## 8. How this collaboration works

Cowork reviews and writes scoped, numbered prompts split into reviewable commits. Claude Code implements, measures, and pushes back. Two conventions have earned their keep and should survive:

**Tests must fail before the fix.** A test that passes pre-fix is the wrong test. This caught two bad tests in one commit — an optimizer case that gave both players room to start (so no swap was ever proposed), and a parser case where the decoy came *after* the real line and the first-value-wins rule hid the bug.

**Measure, don't assume.** This overturned real decisions: a proposed `localStorage` debounce was implemented, measured at 0.5ms on a 66KB payload, and **removed** rather than kept because it looked right. A `useDeferredValue` fix measured 190ms — i.e. no improvement — and would have shipped with a confident comment on it.

### Premises that did not survive contact with the code

Five so far, all from documents rather than from the code. Treat plan claims — **including this document's** — as hypotheses:

1. "1.63s keystroke freeze" → real browser cost was 191ms
2. "83ms Gameday render" → never verified; measured `simulateLive` was 28–35ms
3. "The un-debounced localStorage write is the likely SAVE ERROR source" → 0.5ms, 1.3% of quota
4. "Intel is a seven-section stack with a duplicate Watchlist" → three separate tabs, no duplication; a `sed` range had over-matched
5. "Beat Wire is unbounded" → already capped at 10 cards. Note this one survived *into a revision that was correcting #4* — corrections tend to fix the challenged sentence and carry its neighbours through unexamined.

Also worth knowing: the auth fix as originally specified was **incomplete** — the review never mentioned `Cache-Control`, so a token check correct in source would have been bypassed at the CDN. That's a different category from a wrong number: a security fix that didn't secure anything.

---

## 9. Useful commands

```bash
npm test                      # 122 assertions, zero deps
node scripts/bench.mjs        # latency + SCAN_RUNS noise analysis
node scripts/matchcheck.mjs   # importer matcher against the real roster
```

Verify the crash-recovery screen without waiting for a crash:
`https://the-huddle-hq.vercel.app/?selftest=boundary`
