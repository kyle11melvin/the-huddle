# The Huddle — locked visual direction

Settled decisions. Recorded so a future session doesn't re-ask or re-litigate
them. If something here changes, change it here in the same commit.

## Palette

**Dark navy, with gold as the SOLE accent.** One accent, not one-of-several —
if a second accent colour seems necessary, the answer is a different value of
navy or gold, or a neutral. `#0A0E17` is already the `theme-color` in
`index.html` and the base of the dark ground.

Status colours (injury, error, locked) are the deliberate exception; they carry
meaning that gold alone can't express. Keep them muted enough not to read as a
second brand colour.

## Player projection gauge

Speedometer form:

- **floor on the left, ceiling on the right**
- **needle at the projection**
- **the range drawn as an arc band**, from the `sd` the projection blend
  already produces — not a second computation, and not an invented spread

### The scale trap — read before building this

`pointDistribution()` in `src/analytics.js` returns three numbers that are NOT
on the same scale, and mixing them draws a wrong picture:

| field | meaning |
| --- | --- |
| `mean` | expected points = `playProb × condMean`. The honest headline number. |
| `condMean` | the if-he-plays branch |
| `sd` | spread of the **if-he-plays** branch — it describes `condMean`, not `mean` |

So `mean ± sd` mixes an expectation with a conditional spread. For a
questionable player (`playProb < 1`) or a bye (`playProb === 0`) the band would
sit somewhere neither number justifies.

Draw the **needle at `mean`** — that's the number the rest of the app treats as
the projection — and the **band from `condMean ± sd`**, labelled as the
if-he-plays range. When `playProb < 1`, that difference is the interesting part
of the card, not something to paper over.

`confident` (from `dispersion.spread < 0.4`) is the existing signal for how much
the sources agree — a natural cue for how firmly to render the band.

## Typography and layout

- **Oversized hero numbers** — the projection is the loudest thing on a card
- **Uppercase micro-labels** — small, wide-tracked, low-contrast against the navy
- **5-item bottom tab bar**

## Icon and logo

**The helmet mark:** navy shell, gold centre stripe, gold facemask, with the
wordmark **THE HUDDLE** in heavy condensed caps.

Replaced an earlier crown mark — the crown is dead, don't reintroduce it.

The asset is authored outside this repo. Never generate a placeholder or an
approximation; use the real file. For the app icon at 180×180 the wordmark is
unreadable, so the icon is helmet-only and the full lockup is for the app header
and splash.

## What else the player card carries

The card is the evidence behind the projection, not just the projection. Four
inputs beyond the gauge, in weight order:

1. **Vegas player props → a bonus eV figure**, alongside the book spread.
   **Props carry the most weight of any input — this is the app's core edge**,
   and the layout should say so rather than giving all four equal billing.
2. **Matchup grade** — schedule-adjusted opponent-defense rating, weighted
   toward recent games.
3. **Expert consensus score** — aggregated across FantasyPros, Footballguys and
   The Fantasy Footballers.
4. **Recent player news** — from FantasyPros.

### Where each of these actually stands today

Recorded because three of the four are not yet what the spec describes, and the
gap is not obvious from reading the code:

| input | today | gap |
| --- | --- | --- |
| props eV | `propsToPoints()` in `src/props.js` returns `{points, parts}` and is real. Lines are **pasted by hand** via `parseProps()`. | no automatic feed; `api/odds.js` exists but isn't wired to this |
| matchup grade | a **manual 0–5 star** rating per player per week (`weeks[week].matchup`), nudging the projection by `×0.4` points in `src/analysis.js:165` | spec wants it **computed** from opponent defense. `src/importer.js:535` notes the schedule-adjusted DvP model needs real game logs — so early season it has almost nothing to work from and must either fall back or admit low confidence |
| expert consensus | one pasted ranking set → per-player `ecr` string + `ecrIndex` | spec wants **three named sources aggregated**; disagreement between them is itself signal, same argument as the projection blend |
| news | `api/news.js` pulls **ESPN's** public feed | spec names **FantasyPros** |

### One unit: points

Where a card element can be expressed in **fantasy points**, express it in
points. `src/analysis.js` already made this call for position need — the sanity
suite asserts *"every value is in points, so a difference has one unit"* — and
the same reasoning applies here. A matchup worth `+2.1 pts` and props worth
`+2.4 pts` can be compared and added; three stars and a rank cannot.

Keep the native unit visible where it carries meaning a point value loses (the
book spread, a rank, a percentage), but lead with the points.

## Dropped from the UI — do not reintroduce

- the tagline **"WIN A BRIGHTER SUNDAY"**
- the curved **"EXPECTED FANTASY RANGE"** label around the gauge
