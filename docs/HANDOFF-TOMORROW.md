# Handoff — Friday evening, Sept 11

Read this first, then `CLAUDE.md`, then `docs/QUEUE.md`.

## State: work is on a BRANCH, not deployed

**Branch: `fix/today-cleanup`** — two commits, `npm run verify` green, working
tree clean, pushed to `origin`.

**Nothing in it is on `main` and nothing is in production.** Kyle has seen
screenshots and has not said merge. Do not merge without him saying so.

```
3f48137  FantasyPros: /api/fantasypros, canonical ids, news in the Scouting Report
2d6591e  Today hero and player card: cut the prose, fix the empty matchup box
```

Also still unmerged from an earlier session: **`docs/future-build`** —
documentation only, no `src/` changes.

## What is in the branch

**Commit 1 — Today hero and player card**

- The hero's narrative callout and the P10–P90 fine print are gone. Both
  restated what the 58px number, the win bar and the two "players left" boxes
  already said. The provenance warning STAYS — it only renders when the
  opponent data is genuinely estimated or stale.
- Both scores rendered gold, which broke the `gold = you / slate = them` rule
  the rest of the board runs on. Your side is gold, his is slate. It
  deliberately does NOT colour by who is projected to win — the prob bar and
  the margin pill carry that, and a win/lose colour on a score makes a forecast
  look like a fact. Kyle proposed green/red; this is a considered
  counter-proposal he has not yet ruled on. If he wants green/red it is two
  lines in `.gd-total` in `src/index.css`.
- The Slot tile is gone from the player modal.
- The week matchup box asked you to TYPE the opponent, so it was blank for all
  16 players while `state.schedule.opps` already held every NFL pairing for all
  18 weeks. It now shows the real opponent and kickoff, typed field kept as an
  override.

**Commit 2 — FantasyPros steps 2, 5, 4**

- `api/fantasypros.js`. 50 requests/**day**, so every resource sits behind the
  same durable Blob cache as `api/odds.js`. Worst case under 30 calls/day.
  There is deliberately **no `fpid` param** — per-player news would be one
  cache entry and one request per player per render. `scoring=PPR` is forced on
  every ranking call; the API defaults to STD and omitting it makes the ranks
  silently disagree with everything else in the app.
- `src/fantasyPros.js`. `resolveFpIds()` writes `fpId` onto each player. 15/16
  of the roster resolves by name; the 16th is the D/ST, which matches on team,
  because "Steelers" will never equal "Pittsburgh Steelers".
- News in the Scouting Report, **additive**. Wire on top, newest first, each
  carrying the date it was true and an INJURY/BREAKING tag. The August seed
  note stays beneath, dated "Aug 2026", `VERIFIED:` stripped.

## Three corrections to `docs/handoff-fantasypros-api.md`

All verified against the live API on Sept 11. **The doc is wrong about these —
do not build on it without re-checking.**

1. **News categories** are `Commentary`, `News`, `Injury`, `Breaking`,
   `Results`. Not the injury/recap/transaction/rumor/breaking the doc lists —
   there is no `transaction` and no `rumor`. Every item carries
   `Commentary`+`News`, so only `Injury` and `Breaking` discriminate.
   `Results` is box-score recap and is dropped.
2. **`/players` carries no ESPN id** — only `sportsdata_player_id`
   (Sportradar). Step 5 therefore does NOT fix ESPN ↔ Odds API matching the
   way the doc claims. It fixes FantasyPros matching, which is what Step 4
   needed.
3. **Step 3's open question is settled: the free tier does NOT truncate.** A
   Week 1 RB call returns 161 rows down to RB161, and `/players` returns 3,820.
   Lemon (WR55), Boutte (WR62) and Robinson Jr. (RB49) would all be present —
   **the API can replace the CSV paste.** Steps 3 and 6 are now unblocked.

## Immediately actionable

- **Waiting on Kyle: merge approval for `fix/today-cleanup`**, and his ruling
  on gold/slate vs green/red for the hero scores.
- **`FANTASYPROS_API_KEY` is Production-only in Vercel.** A preview deploy has
  no feed. Kyle's call whether to add it to Preview — it is his key.
- Steps 3 and 6 of the FantasyPros doc are unblocked by finding 3 above.
  Step 6 (`player-points`) is what makes `calibration.js` mean something by
  Week 4 instead of Week 12.

## Known-open, unchanged

- **Matchup grade has no automatic source.** FantasyPros has no SOS/DvP/matchup
  endpoint — all 403. A real opponent-adjusted grade needs roughly Week 4 of
  game logs. The star picker stays manual until then.
- The FantasyPros wire is league-wide and ~74 items, so on a given day it has
  something about one or two roster players, not sixteen. That is honest
  coverage, not a matching failure — do not "fix" it with a fuzzy matcher.
- Odds API credits exhausted; needs the $30/mo tier.
- Rest of the backlog is in `docs/QUEUE.md`.

## Hard rules

- **`src/espnWrite.js` and `api/espn-write.js` are frozen.** The only path that
  reaches Kyle's real ESPN roster. Ask before touching either.
- **The FantasyPros key never enters the repo, a project doc, or a `VITE_*`
  var.** Vite inlines `VITE_*` into the public bundle and this repo is public.
- Team colours in `src/data/teams.js` are not the brand gold. Four entries are
  `#FFB612` because that is those teams' colour. Never swap them.

## How to work with Kyle

- **Name the root cause before editing.** Size a problem before fixing it. This
  session, three reported bugs ("matchup box empty", "no opponent", "scouting
  report old") turned out to be two causes, not three — and one of those was a
  feature that had never been built rather than a regression.
- **One root cause per commit.**
- **Say plainly when something is built but NOT deployed.** A fix on a branch
  has not shipped.
- **A green `npm run verify` is not proof a UI change is correct.** Render it
  and look at it. `node scripts/shots.mjs /tmp/out`, send PNGs with
  SendUserFile — he reviews from his phone.
- `scripts/shots.mjs` can now photograph the player modal below the fold
  (`unpinModal`). It grows the viewport to the content; `fullPage` alone does
  not pick up a height that only appeared after the unpin.
