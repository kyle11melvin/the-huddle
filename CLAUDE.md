# The Huddle

Fantasy football team HQ for Kyle's league. React + Vite, deployed to Vercel
from `main` (pushing to `main` deploys to production).

## Read these first

Before doing anything, read in this order:

0. **`docs/HANDOFF-TOMORROW.md`** — if it exists, the most recent session's
   handoff. Start there.
1. **`docs/QUEUE.md`** — what is and isn't done. The live list.
2. **`docs/STATUS.md`** — handoff: branch state, what shipped, what's open.
3. **`docs/DESIGN.md`** — locked visual decisions. Don't re-litigate them.
4. **`docs/GAME_SCRIPT.md`** — the live-projection model design, if that's the task.

`docs/SUNDAY.md` is the in-season validation plan for a game day.

Commit messages carry most of the reasoning behind non-obvious decisions —
`git log` is worth reading before changing something that looks odd.

## How Kyle works

- **Name the root cause before editing.** He wants the diagnosis confirmed, with
  evidence, before code moves. Size a problem before fixing it — more than once
  the premise turned out to be wrong.
- **One root cause per commit.** Unrelated fixes go in separate commits.
- **Work on a branch; merge only when he says so.** Say plainly when something
  is built but NOT deployed — a fix sitting on a branch has not shipped, and
  conflating those has bitten this project.
- **Verify visually.** `node scripts/shots.mjs /tmp/out` renders components in
  real Chrome and writes PNGs; send them with SendUserFile. He reviews from his
  phone.

## A green `npm run verify` is not proof a UI change is correct

This has been established the hard way. Bugs that passed every assertion and
were caught only by screenshots:

- a gauge needle that sliced straight through the hero number at most values
- a card rendering "no lines pasted" while holding a full set of Vegas lines
- an "A" injury badge on every healthy opponent (ESPN's `ACTIVE`, truncated)
- player names overflowing into the numbers instead of ellipsing

Render it and look at it. Every time.

## Devices

- **Macbook** — owns team document `kmzrw943`, live sync ON, holds the only copy
  of the write key
- **Dell** — work laptop, sync OFF, safe sandbox
- **iPhone** — sync OFF by design; syncs ESPN directly, gets team data by
  snapshot import

"Live sync is off" on the Dell or iPhone is the intended state, not a symptom.

## Hard rules

- **Never touch `src/espnWrite.js` or `api/espn-write.js` without asking.** That
  is the only path that reaches his real ESPN roster.
- **Team colours in `src/data/teams.js` are not the brand gold.** Four entries
  are `#FFB612` because that is those teams' actual colour. Never swap them.
- **The write key is unrecoverable.** `clearLink()` destroys it; no backup
  contains it; the server stores only its SHA-256. Guard any code path that
  could clear an owner link.
- Backups of every team document live in `~/huddle-backups/`.

## Commands

```
npm run dev       # Vite. NOTE: no /api routes — the client calls production
npm run verify    # lint + sanity + smoke + build. Run before every commit
node scripts/shots.mjs /tmp/out    # screenshots in real Chrome
```
