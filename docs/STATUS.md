# Status — state of play

**Most of the detail below was written 2026-09-10 and has been overtaken.** The
current handoff is `docs/HANDOFF-TOMORROW.md` (Sept 21) — read that first, then
`docs/QUEUE.md`, and treat anything in this file dated older as history rather
than status. The sections that were plainly wrong are corrected in place and
marked.

## Branch state — as of Sept 21

| branch | state |
| --- | --- |
| `main` | deployed, at `85e96d2`. **Everything is shipped — nothing is stranded on a branch.** |

Working tree clean, `main` and `origin/main` in sync.

**Two sessions have been shipping to `main` in parallel.** `main` moved
mid-session more than once and one merge was not clean. Fetch before assuming
your branch point is current.

## Shipped Sept 21

- **A player row leads with the fact.** Live rows lead with points banked, final
  rows with points scored, each with a projection beneath and the direction on
  that projection. Shared through `rowGameState()`, so the paired board and the
  roster list both carry it. Two locked `DESIGN.md` decisions were reversed, with
  the reasoning recorded.
- **The calibration ledger's three gaps** — the freeze now needs a pregame
  number to freeze (this one was a correctness bug), props are graded rather
  than merely stored, and the whole league is recorded instead of my sixteen.
- **The screenshot harness runs off the Mac**, plus two shots that never
  existed: the roster list and the calibration ledger panel.

Full reasoning, and the three things to watch, in `docs/HANDOFF-TOMORROW.md`.

---

**Everything below this line is from 2026-09-10.** Kept for the reasoning, not
as a statement of current state.

## Working agreement

- **Work on a branch.** Merge only when Kyle says so explicitly.
- **Verify visually before claiming done.** `node scripts/shots.mjs /tmp/out`
  renders components in real Chrome and writes PNGs; send them with
  SendUserFile. Kyle reviews from his phone.
- **Name the root cause before editing**, and keep one root cause per commit.
  See the `diagnose-before-changing` memory.
- Devices are **Macbook** (owns the live team, sync on), **Dell** (sandbox,
  sync off), **iPhone** (standalone, sync off). "Live sync is off" on the Dell
  or iPhone is the intended state, not a symptom.

## Shipped and deployed today

All verified in production:

**Visual / feature**
- live projection **decay** — Gameday rows fall as games are played
- **side-by-side matchup board** — slot against slot, detail line, progress track
- **player card** in the modal — projection gauge, lit arc, real Vegas props
- **one gold** (`#e8b95a`) app-wide through a single token
- matchup tile made honest — no fictional `+2.1 pts`, no letter grade on a player

**Correctness**

1. dev reads the live team document but never writes to it — `remoteStore.js`
   was the only client module missing the `import.meta.env.DEV` prod-base, so
   in dev the GET was served `api/team.js` SOURCE as a JS module and the PUT
   404'd
2. never mirror a document we failed to read (`remoteVerified`) — a real prod
   bug reachable by any transient network failure
3. snapshot import can adopt a team as this device's own (`asMine`)
4. the mint trap closed — reconnect path, write-key reveal, publish preview
5. the write key survives a failed read; `stopLive` confirms before discarding
6. the badge no longer reads "SYNCED" on a device with no sync

Plus: a flaky `untilKick` test pinned, smoke coverage for the data panel's
owner and viewer states, and PWA support (manifest, iOS metas, safe-area inset).

## Data recovery that happened today — context for anything touching sync

Three devices had each minted their own team document, going back to mid-August.
Six orphan blobs were deleted; the blob store now holds exactly one document,
`kmzrw943`, which is Kyle's real team. Backups of everything are in
`~/huddle-backups/`.

The write key for `kmzrw943` was destroyed mid-session by `clearLink()` firing
on a `notFound` read (fix 5 above closes that). Recovery was: delete the blob
out-of-band with `BLOB_READ_WRITE_TOKEN`, re-claim the id with a fresh key,
restore byte-identical state from backup. Kyle now holds the key in a password
manager. **It is still single-copy in one browser's localStorage plus that
manager — no backup contains it, and the server stores only its SHA-256.**

## ~~On the branch, awaiting review~~ — ALL SHIPPED since

- `src/gaugeGeometry.js` — pure geometry, 11 sanity assertions
- `src/components/ProjectionGauge.jsx` — the speedometer
- `src/components/PlayerCard.jsx` — gauge + evidence tiles + news
- `scripts/shots.mjs` + `scripts/shots-entry.jsx` — the screenshot harness

All four are on `main` and reachable: `PlayerCard` renders in the modal and in
`OpponentCard`, and the harness is the documented way to check a UI change. The
"not wired into the app" note below it was true on Sept 10 and is not now.

### Two things screenshots caught that no assertion could

Worth internalising before trusting a green `npm run verify`:

1. the first gauge pivoted its needle from the centre, so it **sliced straight
   through the hero number** at any near-vertical value. Passed every check.
2. `PlayerCard` destructured `props:` while the harness passed `propsEdge:`, so
   a card holding a full set of Vegas lines rendered "No lines pasted for this
   week". Rendered fine, passed, silently wrong.

## Next, in order  — *(step 1 is done; 2 and 3 still stand)*

1. ~~**Wire `PlayerCard` into `PlayerModal`.**~~ Done and deployed.
2. **The helmet icon.** `public/apple-touch-icon.png` and `public/icons/*.png`
   per `docs/ICONS.md`. The asset is authored outside the repo; **never
   approximate it**. Until it lands, iOS falls back to a screenshot of the page
   and the app should not be added to a home screen — iOS captures the icon at
   add time and only a remove-and-re-add picks up a new one.
3. **The three missing feeds**, in `docs/DESIGN.md` weight order: Vegas props
   (currently pasted by hand; `api/odds.js` exists but isn't wired), the
   schedule-adjusted matchup grade (currently a manual 0–5 star nudge; the DvP
   model needs game logs that barely exist in week 1), aggregated expert
   consensus across three named sources (currently one pasted ranking set).

## Open questions for Kyle

- **Green.** `docs/DESIGN.md` says gold is the sole accent; his v6 mockup used a
  green `B-` for matchup. Built gold-only. Trivial to flip.
- **Matchup as letter or points.** Currently shows both — `B+` with
  `+2.1 pts` beneath.

## One real bug found but NOT fixed

The stored per-player `ecr` is a **season-long** rank that knows nothing about
injuries. Brock Bowers is filed as `TE1` in the live document while listed
doubtful. The card now strikes it through and labels it stale — but `ecr` also
feeds `rankToPoints()` in `src/analysis.js`, which feeds the **lineup
optimizer**. If season-long ranks are being treated as current for injured
players, the optimizer may be making the same mistake with nothing on screen to
show it. Worth investigating on its own.
