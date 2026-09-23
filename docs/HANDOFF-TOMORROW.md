# Handoff — Sept 23

Read this first, then `CLAUDE.md`, then `docs/QUEUE.md`.

Everything below is **on `main` and pushed** (merge `9419ad5`). The push to
`main` triggers Vercel; this session's container could not reach vercel.app to
confirm the deploy, so Kyle was given steps to check on his phone (bottom bar
visible = live). If a later session can reach it, confirm.

## What this session was

Kyle asked how to run **Impeccable** (`pbakaus/impeccable`, a design-review
skill + deterministic detector) on The Huddle. It became a review, then fixes.

- **Detector:** `npx impeccable detect --json src/` runs fine from a container.
  18 findings, all in `src/index.css`: 14 one-side "side-tab" stripes, 2
  gradient-text (hero title, FAAB amount), 2 `transition: width` bars.
- **Critique:** `npx impeccable install` is refused from a container (signed
  bundle redirect → 403). Workaround used: `git clone` the repo into the
  scratchpad and follow `skill/reference/critique.md` by hand — Assessment A
  as an isolated sub-agent that never saw the detector output, per its rules.
  Scored **22/40**. Its findings, and what happened to each, are in QUEUE.md
  under "Impeccable review".
- The critique was wrong twice, and both were caught before code moved: it
  said Apply gives no confirmation (it does — `✓ Lineup updated on ESPN`), and
  it called the gauge needle crossing the number a regression (it is de95835's
  deliberate trade). Verify its claims against the code; don't relay them.

## What shipped (six commits, one root cause each)

1. **League strip** — my team on the left even when I'm home. ESPN lists
   away-then-home; the strip never checked which side was mine.
2. **Hero margin pill** — coloured by `outcomeColor(winProb)` like the totals,
   not red-by-sign; captioned PROJ / MARGIN. Yet-to-play boxes read
   "N yet to play". The caption on one line truncated BROCK HARD — it wraps.
3. **Opponent roster never loaded** — NOT LOADED line where the hero would be,
   a dim dash instead of EMPTY, no edge chips. The warnings used to live only
   inside the hero, which does not render without a sim.
4. **Gauge caption** — PROJECTED gets the hero number's knockout halo (3px).
5. **Bottom tab bar** (`src/components/TabBar.jsx`) — the 5-item bar DESIGN.md
   locked on Sept 10 and nobody built. Kyle chose Today / Roster / Start/Sit /
   Intel / More; More holds Watchlist, Waivers, Game Log and takes the open
   one's name. `--tabbar-h` drives content padding (including the separate
   ≤560px override) and the toast's offset.
6. **Header** — full lockup on Today only; other tabs keep every control with
   a 26px wordmark (`.hero.compact`). Kyle's choice.

## How it was checked

`npm run verify` before every commit, and renders of every change. For the tab
bar, the static harness can't tap, so the real app was built, served with
`npx vite preview`, and driven with puppeteer-core at 390×844 (Today → Roster →
More → Waivers → bottom of Waivers). Throwaway scripts for that lived in
`scripts/.*-tmp.mjs` and were deleted — note that eslint lints them, so a
leftover one fails `verify` (it happened once, on an uncommitted file).

## Still to watch from Sept 21

The calibration ledger's first big sync, its first graded week on a phone, and
whether props earn their precedence — see the Sept 21 handoff in `git log`
(`4baec95`) for detail. Nothing this session touched the ledger.
