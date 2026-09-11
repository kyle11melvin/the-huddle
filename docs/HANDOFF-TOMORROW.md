# Handoff — Sunday morning, Sept 11

Read this first, then `CLAUDE.md`, then `docs/QUEUE.md`.

Written the night before by the session that shipped everything below. It is
current as of the last commit on `main`.

## Today is a VALIDATION day, not a build day

Week 1 slate, roughly 10am–4pm PT. `docs/SUNDAY.md` is the plan. The one thing
that matters: **does the live projection decay track reality**, and where does
the clock-vs-plays approximation break down.

Two cases decide whether the play-rate model in `docs/GAME_SCRIPT.md` is worth
building:

- **a blowout fourth quarter** — winning team kneeling, starters pulled.
  Expected to OVERSTATE.
- **a two-minute drill** — trailing team throwing every snap. Expected to
  UNDERSTATE.

Note the player, the score, and roughly what the projection said versus what he
actually did. That data exists on no other day of the week.

Kyle will be watching on his phone and sending observations mid-slate. That is
the validation loop, not an interruption — keep building and keep shipping.

## State

Everything built is **on `main` and deployed**. Nothing is stranded on a
feature branch. Working tree clean.

One unmerged branch: **`docs/future-build`** — documentation only, no `src/`
changes. It holds the season-long ideas (F1–F4) and the matchup board review.
Merge whenever; nothing deploys differently.

## The next piece of work, and the thing to wait for

Kyle is producing **an approved reference for a matchup board rebuild**. Build
against that reference when it lands — not against the review list in
`QUEUE.md`, which is captured complaints rather than a spec.

The root finding, which the reference will resolve:

> Kyle read the shipped board and concluded he was the opponent. He isn't —
> `myTeamId` is 7, Brock Hard. `liveNarrative()` reads entirely from his own
> lineup, so the logic is correct. But the person who BUILT the app couldn't
> tell which side was his. There is no single concept of "my team" threaded
> through the page; each section decides independently.

Fix the anchor — always left, always marked, Sleeper's convention — and the
perspective, bar direction and column-order complaints all fall out of it.

## Hard rules for today

- **Do not touch `src/espnWrite.js` or `api/espn-write.js`.** Frozen until
  Monday. It is the only path that reaches Kyle's real ESPN roster, and he is
  not watching closely. If something seems to need it, stop and ask.
- Roster moves happen in the ESPN app, not here.
- Shipping to `main` during the day is fine and expected — Kyle's lineup lives
  on ESPN, so a broken screen costs a view, not a game.

## How to work with Kyle

- **Name the root cause before editing.** Size a problem before fixing it —
  more than once the premise turned out to be wrong, and sizing first is what
  caught it.
- **Say plainly when something is built but NOT deployed.** A fix on a branch
  has not shipped. Conflating those has bitten this project twice.
- **Verify visually.** `node scripts/shots.mjs /tmp/out` renders real components
  in real Chrome; send PNGs with SendUserFile. He reviews from his phone, so
  check at **375px**.
- **A green `npm run verify` is not proof a UI change is correct.** Seven bugs
  in the last session passed every assertion and were caught only by
  screenshots. Render it and look at it.

## What shipped in the last session

Correctness: dev/prod sync bug, never-mirror-an-unread-document, write-key
preservation, the loud opponent-fallback with a staleness bound that tightens
to 10 minutes while his players are live, badge honesty, a flaky test pinned.

Feature: live projection decay, the side-by-side matchup board with three game
states, the player card wired into the modal, tap-any-player including a
read-only opponent card, one gold app-wide, PWA manifest.

Recovery: six orphan team documents deleted, `kmzrw943` restored byte-identical
with a new key Kyle now holds. Backups in `~/huddle-backups/`.
