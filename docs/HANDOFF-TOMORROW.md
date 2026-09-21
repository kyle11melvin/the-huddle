# Handoff — Sept 21, end of session

Read this first, then `CLAUDE.md`, then `docs/QUEUE.md`.

Everything below is **on `main` and deployed**. `main` is at `85e96d2`. Working
tree clean, nothing stranded on a branch.

## What this session was

Two things, in order: Kyle asked for the ESPN treatment on live rows, then for
the three fixes to the calibration ledger that came out of asking whether we
were storing pregame projections at all.

## 1. A player row leads with the fact, not the estimate

**The root cause**, in his words and then in the code: while a game is running
the board showed the decayed projection large with the pregame figure struck
beneath it. So the one number on the row that was *not* an estimate — what he
had actually scored — was the one number not on the screen, on the screen you
only look at while the games are on. ESPN's matchup tab was the reference.

Now, in `rowGameState()` (`src/simulate.js`), for every surface:

| state | headline | beneath |
| --- | --- | --- |
| PRE | the projection | nothing |
| LIVE | points banked | projected finish, directional |
| FINAL | what he scored | **pregame** projection, directional |

**Two reversals of earlier locked decisions are recorded in `DESIGN.md`. Do not
quietly revert them.**

- Final used to show ONE number, on the reasoning that a projection is dead once
  the game ends. It is the opposite: "projected 14.4, got 2.1" is the entire
  grade on a finished player.
- Which projection sits underneath differs by state, and has to. At final the
  live projection has already collapsed to the actual, so printing it would
  print the headline twice.

The direction (red below pregame, green above) moved onto the number *beneath*.
Points already banked are a fact and carry no direction.

**`worth` and the displayed number have deliberately come apart.** The centre
slot edge still weighs projected finish, because a comparison run on banked
points would hand the slot to whoever kicked off first. `rowGameState` returns
both; do not "simplify" them back together.

### This landed on two surfaces, not one

A parallel session had just moved the three-state model out of the board into
the shared `rowGameState()`, so the roster list inherits all of the above. The
roster row's number block was stacked to match. Anything touching that function
now changes both screens — check both.

## 2. The calibration ledger — three gaps closed

`src/calibration.js`. All three were real; one was a correctness bug.

**The freeze needed a pregame number to freeze.** Locking meant "recompute the
projection on the first sync at or after kickoff, stamp it locked". That only
holds if an earlier sync ran. Open the app for the first time on Sunday
afternoon and the week's first capture was a post-kickoff projection wearing a
pregame label — the model graded against a number it revised with the game in
front of it. Now: a row captured before kickoff is locked AS IT STANDS and never
recomputed; a player with no pregame row gets no projection and no actual, and
is counted in `missed`.

**Props are graded now, not just stored.** `sources.props` had been recorded
since week 1 and nothing ever read it back. Note what it is *not*: props are not
a blend weight, they REPLACE the ESPN/FantasyPros blend outright whenever a line
exists (`analytics.js`). So `sourceAccuracy()` measures that precedence, as a
PAIRED test on rows where all three sources projected the same graded player —
comparing props on the games they cover against the blend on different games
would measure which games are easy, not which source is better. **Reported,
never applied.** Flipping the precedence is a model change and Kyle's call.

**It records the whole league, not my sixteen.** Sixteen rows a week is ~250 a
season and the ledger could have spent the year never crossing its own
thresholds. Every league roster arrives in the same sync with a projection and
an actual, and both other sources are reachable by name — `/api/odds` already
sweeps the whole slate. ~90 rows a week in a 10-team league; both thresholds
(20 props, 60 blend) should clear in week one. No extra API call.

League rows carry `scope: "league"` and **no `proj` of their own**, because
`pointDistribution` needs a roster player. That absence is load-bearing: it is
what `calibrationSummary`'s finite-proj guard uses to keep them out of the bias
and band statistics, where a row with no `sd` would count as a miss and wreck
the number. There is an assertion pinning exactly that, because nothing else
enforces it.

## What to watch, in order

1. **The first sync after this deploy** is the biggest single write the team
   document has ever taken. Measured: 247 bytes a league row, ~390 KB across a
   10-team season, ~470 KB at 12. That makes the ledger the largest thing in the
   document, and it re-serialises and syncs on every save. If saving starts
   feeling slow, or a storage error appears, this is the thing that grew.
2. **The first week with graded rows.** The ledger panel's *measured* branches
   have never been rendered — the shots fixture did not survive the app's state
   migration, so they are pinned by assertions only. Look at that panel on a
   phone the first Sunday night it has numbers in it.
3. **Whether props are earning their precedence.** The panel will say. If the
   blend is ahead, that is a real finding and the fix is a model change, not a
   refit — bring it to Kyle rather than changing it.

## Still open on the ledger

The three hand-picked constants the file's own header names — `BASE_CV`,
`PLAY_PROB`, `TEAM_LOAD` — are still not fit from the ledger. `sd` and
`playProb` are being stored, so the data will be there. That was always
offseason work, not a defect.

## The screenshot harness runs off the Mac now

`node scripts/shots.mjs /tmp/out` used to need Kyle's Macbook: a hardcoded
Chrome path and two fixtures read from `/tmp/ka.json` and `/tmp/now.json`. So
the project's first rule — look at the render — was unfollowable anywhere else.

- `HUDDLE_CHROME=/path/to/chrome` overrides the browser (a parallel session
  added this; `--no-sandbox` follows automatically). On the Mac, unchanged.
- `TEAM_DOC` / `TEAM_DOC_PRE` override the fixture paths, and when they are
  absent it falls back to the smoke fixture — the real board, not a stand-in.
- Two new shots: `roster-rows.png` and `screen-ledger.png`. The roster list is
  the most-used screen in the app and had no shot at all; the ledger panel
  reports whether the model is any good and was itself never looked at.

Rendering a whole tab needs a browser shim, which is why `shots.mjs` grew a
block of `globalThis` assignments at the top.

## Hazard worth knowing

Another session (`claude/ecstatic-pasteur-gn14o9`) shipped a lot to `main` in
parallel today — kickoff awareness, opponent pricing through the same ladder,
the roster screen's game states. `main` moved under this branch mid-session and
the merge was not clean. **Fetch and rebase before assuming your branch point is
current**, and read `git log` before changing anything in `simulate.js` or
`analytics.js`.
