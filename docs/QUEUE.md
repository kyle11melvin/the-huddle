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
