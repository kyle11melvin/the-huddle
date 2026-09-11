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

## A trap this shares with the matchup model

Projections lead with **Vegas props**, and the book has already priced the
expected game script into the line. A quarterback on a team favoured by 10 has
already had his passing volume marked down. Applying a script multiplier on top
of a props-derived projection risks charging him twice for the same game state.

The adjustment should know which projection source it is modifying. This is the
same constraint recorded for the matchup model in `docs/DESIGN.md`, and it is
the easiest way for either to look sophisticated while being wrong.
