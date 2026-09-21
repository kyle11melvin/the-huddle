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

### Constraints the matchup model must satisfy

Three findings, each of which would break a naive implementation. Written down
because they are not visible from the code:

**1. It currently affects nothing.** `matchupStars` does not enter
`pointDistribution()` at all. The only place it moves a number is the rank
fallback at `src/analysis.js:165`, which **zero of 16 players on a synced
roster reach** — measured, not assumed. Until the real model exists the card
must present it as a READ, never as a contribution. It printed "+2.1 pts" for a
while; that was fiction.

**2. Vegas already priced the opponent — so key off SURPRISE, not state.**
Projections lead with Vegas props, and a book line for a player facing PIT *is*
the line against PIT. Multiplying that by a separate matchup factor penalises
him twice for the same defense.

The fix is the same one that rescues the game-script model (`docs/GAME_SCRIPT.md`):
adjust on the difference between what happens and what the book implied, never
on the raw state. For a matchup that means the signal is not "PIT is a good run
defense" — the market knows that and it is in the line already. It is "PIT is
better against the run than the market has priced," which is a claim about the
market being wrong, and is the only version that can carry an edge.

In practice that makes the spread and implied total INPUTS to the matchup model,
not just display fields on the card.

**3. Elite players are matchup-resistant; the effect is tier-dependent.**
Kyle's framing: *"I'm not dropping Gibbs to RB30 because he plays a top-10 run
defense."* Volume insulates workhorses — Gibbs gets his 20 touches against
anyone, while a committee back in the same spot sees 8 and vanishes. A flat
star rating applied uniformly across tiers is wrong no matter how it is
displayed, and the error is largest exactly where it hurts most: the start/sit
call on a stud.

The likely correct shape is therefore NOT "scale the mean". It is either a
tiebreaker between players already close on projection, or a **volatility**
signal — a brutal matchup widens the range rather than lowering the centre,
which is also what the gauge is built to show.

### Naming

The tile reads **BRUTAL / TOUGH / NEUTRAL / GOOD / SMASH**, not a letter grade.
A letter beside "RB2" reads as a verdict on the PLAYER — the app appearing to
call the second-best back in football a D — when it means he drew a defense
that guts running backs. Name the opponent read and the ambiguity disappears.

## The myTeam anchor, and colour that means something

Three rules, in order of how expensive they are to get wrong.

### 1. One anchor: myTeam is resolved ONCE and threaded everywhere

`state.espn.myTeamId` is the single source of truth. Every section of a matchup
view — hero, player rows, league strip — takes its side from that one value.

**myTeam is ALWAYS the left column.** Sleeper's convention, and the point is
consistency rather than the specific side.

Why this is a rule and not a preference: the sections used to decide
independently, and the result was that the person who BUILT the app read the
live board and concluded he was the opponent. He then filed a perspective bug
against logic that was correct. Nothing on the screen said which side was his,
so there was no way to be right. A reader must never have to infer ownership.

Every narrative string is written in **second person about myTeam**, and is
asserted — see the narrative-perspective checks in `scripts/sanity.mjs`.

### 2. Gold is you. Slate is them. Always.

`--gold` (`#e8b95a`) is myTeam. `rgba(255,255,255,0.055)` is the opponent.

Green is banned from this role. It reads as "good" rather than "yours", so on a
win bar it points at whoever happens to be favoured — which is the opponent
about half the time, saying the opposite of what it appears to say.

### 3. No colour-only signals

Every state carries a **word** as well as a colour: `You 25%` / `Him 75%`,
`FINAL`, a clock, a kickoff time. Colour is the fast channel, not the only one.

It has to survive a glance at a phone in sunlight, and a viewer who cannot
distinguish the hues at all should lose speed, never meaning.

## Gameday paired board — the three game states

Reference: `docs/design/gameday-paired-board.png`, from the approved artifact
study. Match the treatment, not the markup.

**The problem it solves:** you could not tell at a glance which players were
done. "Final" rendered as 8px grey type in a corner and all three states
otherwise looked identical.

| | number | name / meta | chip | track | row |
| --- | --- | --- | --- | --- | --- |
| **FINAL** | **ONE** number, white, solid — what he actually scored | recede to muted slate `#63768F` | solid `FINAL` | full, muted grey | — |
| **LIVE** | **banked points** large and white, **projected finish** beneath | normal | red, quarter + clock (`Q3 6:14`) | partly filled, red | red edge |
| **PRE** | projection alone, grey | normal | kickoff time | empty | — |

**Never show two numbers except while live.** A projection is dead once the
game ends — it is a fact now, not an estimate, and showing both invites a
comparison that no longer means anything. Pre-kickoff there is one number and
it is an estimate. Two numbers means *this is moving*.

**While live, the fact leads and the estimate sits under it** (Kyle, Sept 21,
against ESPN's matchup tab as the reference). The board used to lead with the
decayed projection and strike the pregame figure beneath it, so the one number
that was not an estimate — what he has actually scored — was the one number not
on the screen. The pregame figure is gone from the row: it is the least useful
of the three once a game is running, and the direction of the projection
already says which way he is going.

The slot edge in the centre column still weighs *projected finish*, not banked
points, so it does not hand a slot to whoever kicked off first.

**Rows where BOTH sides are final sink** — dimmer background, dimmer slot
badge. Ten rows then collapse into "here's what's left" without reading a word.

**Live projections read DIRECTIONALLY:** below pregame is red, above is green.
A player fading and a player going off must not look the same. The direction
belongs to the projection beneath, never to the banked points above it — those
are a fact and carry no direction.

**Every state carries a WORD** — `Final`, a clock, a kickoff time. Never colour
alone: it has to survive a glance in sunlight, and colour alone also fails a
colour-blind reader entirely.

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
| matchup grade | a **0–5 star** rating per player per week, imported. It moves NO number on a synced roster — see the constraints below | spec wants it **computed** from opponent defense. `src/importer.js:535` notes the schedule-adjusted DvP model needs real game logs — so early season it has almost nothing to work from and must either fall back or admit low confidence |
| expert consensus | one pasted ranking set → per-player `ecr` string + `ecrIndex` | spec wants **three named sources aggregated**; disagreement between them is itself signal, same argument as the projection blend |
| news | `api/news.js` pulls **ESPN's** public feed | spec names **FantasyPros** |

### One unit: points

Where a card element can be expressed in **fantasy points**, express it in
points. `src/analysis.js` already made this call for position need — the sanity
suite asserts *"every value is in points, so a difference has one unit"* — and
the same reasoning applies here — but ONLY where the app actually computes a
point value. The matchup tile is the counter-example: it briefly printed
"+2.1 pts" for a contribution that does not exist, which is worse than showing
a rank. Express in points what IS points; never manufacture a point value to
satisfy the rule.

Keep the native unit visible where it carries meaning a point value loses (the
book spread, a rank, a percentage), but lead with the points.

## Dropped from the UI — do not reintroduce

- letter grades on the matchup tile — see Naming above
- the tagline **"WIN A BRIGHTER SUNDAY"**
- the curved **"EXPECTED FANTASY RANGE"** label around the gauge
