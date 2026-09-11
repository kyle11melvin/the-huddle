# Status — handoff as of 2026-09-10

Written for whoever picks this up next. Current state, what's deployed, what
isn't, and what to do in what order. `docs/DESIGN.md` holds the locked visual
direction; this file holds the state of play.

## Branch state

| branch | state |
| --- | --- |
| `main` | deployed to production. Everything below under "shipped" is live. |
| `feat/player-card` | **3 commits ahead, unmerged, NOT deployed.** The gauge and player card. Kyle reviews screenshots and says merge; do not merge unasked. |

Working tree clean. `main` and `origin/main` are in sync.

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

Six fixes, all verified in production:

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

## On the branch, awaiting review

- `src/gaugeGeometry.js` — pure geometry, 11 sanity assertions
- `src/components/ProjectionGauge.jsx` — the speedometer
- `src/components/PlayerCard.jsx` — gauge + evidence tiles + news
- `scripts/shots.mjs` + `scripts/shots-entry.jsx` — the screenshot harness

**Not wired into the app.** Tapping a player still shows the old `PlayerModal`;
none of this renders anywhere a user can reach.

### Two things screenshots caught that no assertion could

Worth internalising before trusting a green `npm run verify`:

1. the first gauge pivoted its needle from the centre, so it **sliced straight
   through the hero number** at any near-vertical value. Passed every check.
2. `PlayerCard` destructured `props:` while the harness passed `propsEdge:`, so
   a card holding a full set of Vegas lines rendered "No lines pasted for this
   week". Rendered fine, passed, silently wrong.

## Next, in order

1. **Wire `PlayerCard` into `PlayerModal`.** This is the step that makes any of
   it visible. Needs real values plumbed for the four inputs — most will be
   absent, which the card already handles explicitly.
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
