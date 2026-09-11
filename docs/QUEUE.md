# Queue

Everything agreed and not yet finished. Status is as of the last commit that
touched this file — check `git log` if it looks stale.

`docs/DESIGN.md` holds locked visual decisions. `docs/GAME_SCRIPT.md` holds the
game-script projection design. `docs/STATUS.md` is the session handoff.

## Near-term

### 1. Gold swap — ✅ SHIPPED

`#ffb612` → `#e8b95a` app-wide, deployed. Made it genuinely one value rather
than one declaration: 30 scattered `rgba(255,182,18,…)` literals now derive from
`--gold` / `--gold-rgb` / `--gold-hi` / `--gold-dk`. All 13 screens shot before
and after. Team colours in `data/teams.js` untouched — those are the real
colours of real teams, not the brand gold.

### 2. ecr staleness on the card — PARTLY DONE

Bowers renders `TE1` while doubtful. Now struck through and labelled
`season rank · stale (D)`, so it no longer reads as current.

**Still open:** the underlying `ecr` is season-long and injury-blind. The real
fix is the weekly, injury-aware consensus in `DESIGN.md`. Display-only —
the optimizer is unaffected, sized and closed (see below).

### 3. Gameday head-to-head — PARTLY DONE, not deployed

Built on `feat/head-to-head`: one row per starting slot, mine left, theirs
mirrored right, slot badge centred, projections on the inside edges. Starters
only, sorted by slot never by live status, uneven depth zips to the longer side.
9 assertions on the pairing.

**Answering the question you asked first:** long names truncated badly at phone
width — "Trevor…" / "Matth…" — because the name column is about half a screen.
Fixed with `shortName()`: `T. Lawrence`. Defenses keep the team name, since the
first pass turned `Lions D/ST` into `L. D/ST`.

**Still open, from your spec:**
- under each name: position, team, bye, kickoff time and opponent, injury tag inline
- game-progress track with team logo at the outer end
- status line below: Not yet started / live clock / Final
- bench as a collapsed section, or nowhere

### 4. The three missing feeds

Vegas props, matchup grade, expert consensus. **Check the earlier FantasyPros
API probe sessions before starting fresh** — that work exists and shouldn't be
redone.

Note: props are further along than `DESIGN.md` implies. `api/odds.js` is wired
and `propsProj` / `propsParts` / `propsSource: "odds-api"` are real on the live
roster. The gap is matchup and consensus.

### 5. Verification rule into DESIGN.md

As a standing rule, not a status note: **a green `npm run verify` is not proof a
UI change is correct.** Two bugs today passed every assertion and were caught
only by screenshots — a needle that sliced through the hero number at most
values, and a card that rendered "no lines pasted" while holding a full set of
Vegas lines.

### 6. Helmet SVG + PWA icons — blocked

Draft it from `docs/ICONS.md` and show a render; faster than hunting a file that
may not exist. Until icons land, **don't add the app to a home screen** — iOS
captures the icon at add time and only a remove-and-re-add picks up a new one.

## Game-script projections

Design written up separately in **`docs/GAME_SCRIPT.md`** — write/refine that
before building. Summary: count remaining PLAYS not minutes, position-specific
multipliers driven by score differential, receiving backs as the exception,
blowout pull risk as a step not a multiplier, real coefficients from nflfastR,
visible as a separable delta, and logged against finals so it can be cut if it
doesn't beat plain linear decay by Week 4.

## Later / unscoped

- **Step 11b** — opponent projections through the same source-blending pipeline
  as my own roster
- **Second league** (Sleeper) — a real feature, not a tweak
- **Opponent fallback priced as well as loud** — the estimated path is not
  injury-adjusted, so a ruled-out starter is valued as healthy. It now says so;
  pricing it is cheap and still worth doing

## Closed

- **ecr → optimizer.** Sized before fixing, and the premise was wrong. 0 of 16
  players reach the `rankToPoints` fallback; all resolve through
  `pointDistribution`, and the fallback applies `playProb` anyway. A footnote,
  not a bug. The opponent-side `rankToPoints` is unpriced but only runs when
  ESPN isn't synced.
- **Live projection decay.** Shipped and deployed.
- **Opponent fallback made loud.** Shipped, with a staleness bound that tightens
  to 10 minutes while your own players are on the field.

## Season-long / future (not before Week 4)

These are ideas captured Sept 11. None are approved to build. They
are here so they are not lost. Revisit after Week 4, once there are
real games behind the projections and the live-decay model has told
us whether the projections are trustworthy in the first place.

### F1 — Card adaptation as the season matures

The player card is built for Week 1 conditions: consensus rank, ECR,
slot, bye, props. As real games accumulate, some of those tiles get
less useful and others become possible. The card should change with
the season rather than stay fixed.

Retire or demote as the season goes on:
- CONSENSUS and ECR are currently duplicate tiles showing the same
  rank (both read "WR26" on the Parker Washington card). One of the
  two slots is wasted. Decide which one survives and free the slot.
- Preseason ECR loses signal every week. By Week 6 it should not
  occupy prime real estate.

Earn their slot as the season goes on:
- Rest-of-season strength of schedule (see F2)
- Target share / snap share trend (last 3 weeks vs season)
- Realized vs projected differential — is this player beating or
  missing our own number, and by how much

### F2 — Strength of schedule, weighted by when it matters

Generic "SOS: 12th hardest" is close to useless. It averages weeks
that decide nothing with weeks that decide everything. Three cuts of
SOS actually change a decision:

1. Rest-of-season SOS weighted toward playoff weeks. Weeks 15-17 are
   the only ones that decide a title. A player with a brutal Week 8
   and a soft Week 16 is a buy, not a sell. Weight the playoff weeks
   heavily (proposal: weeks 15-17 at 3x, weeks 12-14 at 1.5x,
   everything else 1x) and surface that single number.

2. Next three weeks. That is the window that governs start/sit and
   how much FAAB to spend. A separate, unweighted, short-horizon
   number.

3. Bye-week clustering. If three of my starters share a bye, that is
   a trade signal weeks before it becomes a roster crisis. Detect and
   flag it.

Same thesis as the projections work: everyone has the data, almost
nobody weights it by when it matters.

Open question before building: what is the opponent-strength input?
Season-to-date points allowed by position is noisy early and
contaminated by the opponents that defense happened to face. Prefer
a schedule-adjusted or opponent-adjusted measure. Decide this before
writing any SOS code.

### F3 — Empty states are honest, and that is a problem worth naming

The card currently degrades for depth players: "No book lines for
this player this week", matchup "no data". That honesty is correct
and should be kept. But it means the card is least useful for exactly
the players where a decision is hardest. Consider what a depth player
card should show instead of three empty tiles.

### F4 — Hero number sizing (small, do anytime)

The projected-points number now overlaps the gauge arc, crosses the
needle, and crowds the word PROJECTED. Reduce roughly 25% and re-check
against the approved gauge reference.

## Matchup board rebuild — captured Sept 11, late

Kyle's review of the shipped board. An approved reference is coming; build
against that, not against this list. Captured so nothing is lost.

**The anchor problem is the root, and everything else falls out of it.**
Kyle read the live board and concluded he was the OPPONENT. He isn't —
`myTeamId` is 7, Brock Hard, and `liveNarrative()` reads entirely from
`sim.myNow` / `sim.myLeft` / `sim.winProb`, all built from his lineup. The
logic is correct and self-consistent.

But the person who built the app could not tell which side was his. The hero
prints two names with no marker; the only "YOU" badge sits on a small league
card above, next to the opponent's name listed first. Sections each decide
independently where "my team" goes: the mini card one way, the hero another,
the rows another.

**Fix: one concept of "my team", threaded through every section. Sleeper's
convention — always on the left, always marked.** Perspective, bar direction
and column order all stop being separate questions.

Then, in Kyle's order:

1. **Own matchup pinned to the top**, full width. It currently sits a third of
   the way down, below four cards of other people's 0-0 games. Collapse the
   rest into a compact league strip underneath.

2. **Two headers for one matchup.** The hero shows the names, then a second
   card immediately repeats them with records and yet-to-play — "yet to play"
   appears twice in 200 pixels. Fold records and the positional breakdown into
   the hero; delete the second card.

3. **Invert the numeric hierarchy.** The score is the biggest thing on screen
   and the least useful: at 10:33 Friday, `0` and `8` tell you nothing.
   Projection and players-remaining are what matter.

4. **A stray blue.** The Today pill and both `proj` numbers are iOS system
   blue. The app moved to `#e8b95a`; that blue was never part of it.

5. **Four typefaces on one screen** — condensed caps for names, monospace for
   proj and FINAL, regular sans for game times, rounded for tabs. The monospace
   in particular makes the numbers read like debug output.

6. **The three states still don't separate enough.** A pre-kickoff projection
   and a final score get nearly the same treatment, and the FINAL badge sits in
   a shared bar so it is unclear whose it is. The progress tracks with the
   helmets are unreadable — the fill direction isn't legible.
