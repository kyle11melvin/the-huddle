# Game-script projections — design

Write and refine this before building. The current live decay is deliberately
the simple version:

```
live = points scored + (pregame projection × fraction of game remaining)
```

with `remainingFraction()` derived from the scoreboard clock. That is shipped,
asserted, and honest about being an approximation. Everything below is the
model intended to replace the fraction term.

## 1. Count remaining PLAYS, not minutes

A leading team kneeling and a trailing team spiking burn clock at completely
different rates. Five minutes left in a blowout is a handful of snaps; five
minutes in a two-minute drill is a drive and a half. Clock time is a proxy for
opportunity, and it is a bad one exactly when the score is lopsided — which is
also when the projection error matters most.

## 2. Script multiplier per position

Driven by score differential `d`, measured **from that player's team's point of
view**, in the fourth quarter:

| situation | RB | QB / WR / TE |
| --- | --- | --- |
| leading by 14+ | **up** | down |
| close (±7) | neutral | neutral |
| trailing by 14+ | **down** | QB/WR up hard, TE up |

## 3. Pass-catching backs are the exception

A receiving back in garbage time goes **up**, not down — trailing teams throw
checkdowns, and the back is the checkdown. Split the RB multiplier on receiving
share rather than applying one number to every RB.

Without this split the model is confidently wrong about exactly the players it
is most often asked about.

## 4. Blowout pull risk is a STEP, not a multiplier

At +21 in the fourth, starters come out. That is not a gentle reduction in
expected production — it is a discrete event after which production is zero.

Model it separately: `P(pulled) × 0` for the remainder. A multiplier will happily
project meaningful points for a player standing on the sideline in a baseball
cap.

## 5. Blend with observed pace

Early in a game, weight the pregame projection — one drive tells you very little.
Late, weight what he is actually doing today. The crossover point is itself a
parameter worth fitting rather than guessing.

## 6. Get real coefficients

**nflfastR** publishes free play-by-play going back years, with score and clock
on every snap. Fit the actual relationships instead of hand-tuning multipliers.
Hand-tuned constants are how a model ends up encoding last season's narratives.

## 7. Make it visible and separable

Show base decay with the script adjustment as a **delta**, at least while it is
being evaluated. Not invisible math folded into one number — if it can't be
seen, it can't be judged, and the whole point of the evaluation below is to
judge it.

## 8. Log every projection alongside the final

Compare error **with** the adjustment against **without**. If it isn't beating
plain linear decay by Week 4, it is cleverness rather than edge, and it gets cut.

The app already has a calibration ledger (`src/calibration.js`) that banks
projections against actuals — extend that rather than building a second one.

## Key off SURPRISE, not state

This is the load-bearing correction, and it rescues the model rather than
killing it.

The book prices **expected** game script pre-kickoff. It cannot price how the
game actually goes. So the multiplier must key off the difference between the
two:

```
surprise = realized differential − differential the book implied
```

Worked example. ATL favoured by 2.5, implied team total 21. At halftime:

| state | surprise | adjustment |
| --- | --- | --- |
| up 14–10 | roughly as priced | **none** — the props already cover it |
| down 17 | large negative | Bijan's remaining volume drops harder than clock decay alone; ATL passing rises |
| up 24 | large positive | Bijan's carries rise, ATL passing collapses |

Adjusting on **raw differential** charges the player twice for the same game
state: once in the line, once in the multiplier. Adjusting on **surprise** adds
only information the book did not have — which is the only place an edge can
live.

Two consequences:

**1. The spread and total become model INPUTS, not display fields.** They are
already pulled from The Odds API and currently only rendered. Deriving the
implied differential from them is what makes the surprise term computable at
all.

**2. It sharpens the Week 4 cut criterion into a real experiment.** Log
surprise-keyed error AND state-keyed error against finals. If the adjustment is
fighting the book rather than adding to it, surprise-keyed will beat
state-keyed. That settles the question with data instead of argument, and it is
cheap — both numbers come from the same logged projections.

The same correction applies to the matchup model for the same reason; see
`docs/DESIGN.md`.
