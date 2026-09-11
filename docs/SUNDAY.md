# Sunday validation — what to watch

Week 1 slate. Everything below is deployed. This is a watching day, not a
building day: the goal is finding out whether the live decay tracks reality and
where the clock-vs-plays approximation breaks down.

Open the app on the phone (Chrome). **Close the tab and reopen it once** before
the early games — iOS caches hard and a stale bundle would invalidate the whole
exercise.

## Before kickoff (~9:45am PT)

- Gameday shows the **side-by-side board**: your player left, opponent's
  same-slot player right, slot badge between them.
- Every PROJ is **blue** — nothing has started, nothing has decayed.
- Under each name: `in 2h 15m` style countdowns.
- Tap **⟳ ESPN**. Week should read **1**.

If PROJ numbers are already gold before kickoff, something is wrong — report it.

## During the early window (10am–1pm PT)

The main event. Watch a player whose game is live:

1. **PROJ turns gold** once his game starts.
2. It should **fall as the game runs**, not sit at the pregame number.
3. **PTS rises, PROJ converges toward it.**
4. At Final: **PROJ equals PTS exactly.**

The formula is `points scored + (pregame projection × fraction of game left)`.
A player at 22.2 pregame with 6 points and a quarter to play should read ~11.

**Report anything that doesn't move**, or moves the wrong way.

## The thing actually being measured

Clock time is a proxy for opportunity, and a bad one when the score is
lopsided. Two situations to watch for specifically:

- **A blowout fourth quarter.** Winning team kneeling, losing team's starters
  pulled. Does the app still project meaningful points for players who are
  effectively done? Expected to OVERSTATE.
- **A two-minute drill.** Trailing team throwing every snap. Does it understate
  what the WR/QB actually produce? Expected to UNDERSTATE.

Those two cases decide whether the play-rate model in `docs/GAME_SCRIPT.md` is
worth building. Note the player, the score, and roughly what the projection said
versus what he actually did.

## Also worth a glance

- **Ruled-out player:** projection should COLLAPSE to points banked, not fade
  slowly. A slow fade reads as "still has a chance" when he doesn't.
- **STALE banner:** should appear if a sync stops for 10+ minutes while your
  players are live. Should NOT appear during normal operation — the poll runs
  every 2 minutes.
- **Tap into a player:** the card with the gauge should open, with real Vegas
  props.

## What NOT to do

- Don't turn on live sync on the phone. It syncs ESPN directly and doesn't need
  it; that button is what created the orphan documents.
- Don't clear site data — it holds the team snapshot and the Huddle token.
- Roster moves go in the ESPN app, as usual. `espnWrite.js` is frozen until
  Monday.

## Reporting

Screenshot whatever looks wrong, or just say the player and what the number
should have been. Mid-slate is the right time — that data doesn't exist any
other day of the week.
