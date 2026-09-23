# Handoff — FantasyPros API

> **STATUS Sept 23 — Steps 1–2 SHIPPED and live (merge `3717114`).** Premium key
> in Vercel as `FANTASYPROS_API_KEY` (updated Sept 23; the Sept 11 value was the
> stale pre-upgrade key). `api/fantasypros.js` serves one position × one kind
> (`rank`|`proj`) per call; `src/fantasyprosSync.js` scores projected stat lines
> with LEAGUE scoring (Kyle's call) and fills the same fields the CSV paste did.
> A paste still wins its week and is the only source of matchup stars (not in
> the API). Kyle confirmed the "FantasyPros: … projections and … ranks" toast on
> his phone. **Step 4 (news) shipped Sept 23** — `kind=news`, resolved to
> players via the ranking rows' `player_id`, shown dated in the Scouting
> Report. **Step 6 is superseded:** the ledger has taken actuals from the
> ESPN sync since Sept 21. Step 5 (canonical ids) is not started.
>
> The cloud workspace's own "FantasyPros API" credential never worked (proxy
> header), so test from Kyle's terminal or via the deployed `/api/fantasypros`.
> Plan limit is 1 req/s, 500/day — the client paces and the CDN caches 3h.

For a Claude Code session on the MacBook. Repo `kyle11melvin/the-huddle`.

Read `docs/STATUS.md`, `docs/QUEUE.md`, and `CLAUDE.md` first. Add this work to the queue doc as you go.

---

## Why this exists

The app's player news comes from `api/news.js:13`, which fetches ESPN's **articles** endpoint. That returns fantasy opinion columns, not player news blurbs. Real examples pulled from the live Intel tab: *"Bijan Robinson on what his new deal means for the RB position"*, *"Is Parker Washington or Stefon Diggs a better PPR player?"*

Meanwhile the Scouting Report block renders `player.notes` — hand-written seed text in `src/data/seeds.js` that **nothing in the app ever writes to**. Every reference either preserves it (`espnSync.js` carries `existing.notes` through every sync), defaults it to `""`, or renders it. It is frozen by design and has been shown under a "VERIFIED" prefix.

FantasyPros' news endpoint returns dated, substantive player analysis — named analysts, recency stamps, real content. That is the source that clears the bar ESPN's feed does not.

**Important reversal to be aware of:** an earlier note in the tracker said *don't* replace the seed note with the live feed. That judgment was about **ESPN's** feed and it was correct for ESPN. Through FantasyPros the call flips. Don't let the old note block this work, and don't let this work be done with ESPN's articles endpoint.

### Current repo state, verified

- **No `api/fantasypros.js` exists.** Every FantasyPros reference in `src/` is the manual CSV paste path (`importer.js`, `DataPanel.jsx`, `analytics.js`).
- `api/news.js` is ESPN articles only.
- The key is **not** in the repo, in any doc, or in Vercel. It lives only in Kyle's FantasyPros account.

---

## STEP 0 — Resolve the 403. Nothing else can start until this is settled.

**Symptom:** every request to `api.fantasypros.com` returns HTTP 403, body exactly `{"message":"Forbidden"}`.

**What that error means precisely.** AWS API Gateway returns `{"message":"Missing Authentication Token"}` for an unknown route, and `{"message":"Forbidden"}` with `X-Amzn-Errortype: ForbiddenException` when a request **isn't authorized** — missing, malformed, or unentitled API key. So the endpoint path and query params are correct. Do not go looking there. It is the key as received.

**Already ruled out, with evidence — do not re-test these:**

- Not a proxy transport failure. Proxy status showed no relay failures and the response came back through FantasyPros' own CloudFront, so requests are reaching them.
- Not a network allowlist problem. `X-Proxy-Error: upstream denied the request: connection "FantasyPros API", host "api.fantasypros.com"` proves the credential matched the host and fired.
- Not a misconfigured credential binding. The credential row showed no "Not sent" marker.
- Not the `Bearer` prefix. The credential was deleted and re-added with the Prefix field cleared and header name `x-api-key`. Still 403.

**Every prior test ran inside a sandbox**, so key-validity and credential-injection could not be told apart from in there. This session is on a real machine with a real terminal, which is exactly what was missing.

### The test

Run this in Terminal. No Claude, no proxy, real key substituted:

```bash
curl -s -w "\n%{http_code}\n" -H "x-api-key: <KEY>" \
  "https://api.fantasypros.com/v2/json/nfl/2026/consensus-rankings?position=WR&week=1&scoring=PPR"
```

Then, separately, because entitlement can differ per endpoint:

```bash
curl -s -w "\n%{http_code}\n" -H "x-api-key: <KEY>" \
  "https://api.fantasypros.com/v2/json/nfl/news?limit=5"
```

### Decision tree

**JSON returns → the key is fine, the sandbox injection was the problem.** Skip the credential route entirely and go straight to Vercel: key in Vercel env vars, `api/fantasypros.js` calls FantasyPros server-side. That is where it belongs for production anyway, so nothing is wasted. Continue to Step 1.

**403 again → the key or its entitlement is the problem, not our plumbing.** Reset the key on the FantasyPros key page (allowed once per 24h), retry **once**, then stop and report. The next move is a support question — whether free-tier keys are authorized for `consensus-rankings` — and that is Kyle's to send, not something to code around. Do not spend the session trying workarounds.

**One endpoint works and the other doesn't** → that's entitlement scoped per endpoint. Report which, and build against the one that works.

---

### STEP 0 RESULT — settled 2026-09-11. Do not re-test.

**Both endpoints 403 on a real machine, real terminal, no sandbox, no proxy —
with the original key AND with a freshly reset one.**

| test | result |
| --- | --- |
| `consensus-rankings` + key | `403 {"message":"Forbidden"}` |
| `news` + key | `403 {"message":"Forbidden"}` |
| `public/v2/terms-of-use`, no auth | **`200`** |
| `consensus-rankings` with **NO key at all** | `403` — byte-identical to the keyed call |
| deliberately bogus route + key | `403 {"message":"Missing Authentication Token"}` — *different* |

Headers on failure: `x-amzn-errortype: ForbiddenException`, via their CloudFront.

What the controls establish, beyond the doc's original inference:

- **Not network, sandbox or proxy.** `terms-of-use` returns 200 from the same
  host on the same machine.
- **Not the route or params.** A bogus route returns a DIFFERENT error
  (`Missing Authentication Token`). Ours returns `Forbidden`, which is API
  Gateway saying the route exists and the caller isn't authorized for it.
- **Decisive:** the request with NO KEY AT ALL returns byte-identical output to
  the request WITH the key. API Gateway is treating the key as absent — not
  registered, not attached to a usage plan, or not entitled to these routes.

The key was reset once (the 24h allowance) and retried once. Same result.

**This is now a support question, not an engineering one.** Do not build
workarounds and do not re-probe the endpoint shape — it has been isolated.

Most likely answer, given the key page renders an upgrade prompt and premium
access requires Hall of Fame while Kyle has MVP: the free tier issues a key
that is entitled to nothing. If so this is a subscription decision, not a bug.

### RESOLVED 2026-09-11 — THE BASE PATH WAS WRONG. The key was always fine.

**Everything above about the 403 was investigating the wrong thing, and the
doc's own instruction not to look at the path is what kept it hidden.**

The correct base is `https://api.fantasypros.com/public/v2/json/nfl/...`.
This doc specified `https://api.fantasypros.com/v2/json/nfl/...` — no
`/public` — and that base returns `403 {"message":"Forbidden"}` for ANY key,
valid or not.

That is why every control pointed at entitlement: `/v2/json` rejects the
request before the key is ever evaluated, so a good key and no key at all
produce byte-identical responses. The reasoning in the section below was
sound and the conclusion was still wrong, because every test ran against a
base path that cannot succeed.

The tell was in the doc the whole time: the only call that ever returned 200
was `public/v2/terms-of-use` — the `/public` prefix, sitting in plain sight.

**Confirmed working, Week 1, PPR:**

| call | result |
| --- | --- |
| `/public/v2/json/nfl/2026/consensus-rankings?position=WR&week=1&scoring=PPR` | `200`, **261 rows**, down to WR261 |
| same, `position=RB` | `200`, **161 rows**, down to RB161 |
| `/public/v2/json/nfl/news?limit=3` | `200`, dated items with `player_id` and `categories` |

**STEP 3 IS ALSO ANSWERED — the free tier does NOT truncate at 25-30.** 261
WRs and 161 RBs, with every deep player on Kyle's roster present: Makai Lemon
WR55, Kayshon Boutte WR63, Parker Washington WR26. The API CAN replace the
CSV paste, not merely supplement it. Keep the importer anyway per Guardrail 1.

Rankings rows carry `player_id`, `sportsdata_id`, `cbs_player_id`,
`player_yahoo_id` and `player_bye_week` — the cross-references Step 5 needs
are already on the rankings response.

News items carry `created` (timestamped), `player_id`, `categories`, `author`,
`impact`. Everything Step 4 asked for.

Note: HOF was purchased partway through this diagnosis. It was NOT the fix and
may not have been necessary — the path was. Worth checking whether the free
tier serves these endpoints before treating the subscription as required.

### SUPERSEDED — Kyle upgraded to Hall of Fame

Retested immediately after the upgrade: still `403` on both endpoints, control
still `200`.

That is expected rather than discouraging. **The key was reset BEFORE HOF was
active**, so API Gateway issued it bound to the free usage plan, and upgrading
the subscription does not retroactively re-scope an already-issued key.

**Next action, tomorrow:** request a NEW key now that HOF is active. The 24h
reset allowance was spent today, which is the only reason this waits.

Then rerun the two Step 0 curls. The expectation is a 200 with JSON. If it is
still 403 with a key issued under an active HOF subscription, THAT is the
support question — and a much stronger one, because the entitlement argument
will have been eliminated.

Do not re-probe endpoint shape, headers, or the Bearer prefix. All three are
settled above with controls.

**Everything below is blocked until this resolves.** The CSV paste path keeps
working in the meantime, which is exactly why Guardrail 1 says not to remove it.

## STEP 1 — Rotate the key, then Vercel env

The current key **was visible in a screenshot** on Sept 8 and was never rotated. Reset it on the FantasyPros key page before it goes anywhere near production, so the production key was never in an image.

Then: Vercel env var, alongside `ODDS_API_KEY` and `HUDDLE_WRITE_TOKEN`.

**The key never enters the repo, a project doc, or a `VITE_*` var.** Vite inlines `VITE_*` into the public bundle and this repo is public.

---

## STEP 2 — `api/fantasypros.js`

Model it on `api/odds.js`:

- Server-side key from env
- `s-maxage` CDN caching — no private data, no token gate, same as `/api/odds` and `/api/news`. **Do not** copy `api/espn.js`'s `private, max-age=30`; that is token-gated and its caching is deliberate and different.
- **Query-param guard.** Unknown params bust the CDN cache key. That nearly drained the Odds API tier once, and the margin here is far thinner — see Step 3.
- Fetch timeout, same as the other routes.

### Known API details

- Auth: header `x-api-key`. No query-param auth.
- Rankings: `GET /v2/json/nfl/{season}/consensus-rankings` — `position` required (ALL, QB, RB, WR, TE, K, DST, FLX…); optional `experts`, `filters`, `scoring` (STD/PPR/HALF), `type` (ROS/DK/WW/ADP), `week`.
- **`scoring` defaults to STD.** This league is PPR with bonuses. Every call must pass `scoring=PPR` explicitly or the ranks will quietly disagree with everything else in the app. This is the single easiest way to corrupt the data silently.
- News: `GET /v2/{format}/nfl/news` — optional `fpid`, `limit`, and `category` filters for **injury, recap, transaction, rumor, breaking**. That category filter is what makes this a real intel source rather than article soup.
- No SOS endpoint is documented.

### Rate limits — free tier

- **50 requests/day.** One cached fetch per endpoint per day is well inside it; anything per-player-on-render is not.
- Caching is explicitly requested in their terms: don't poll unnecessarily.
- Key reset allowed once per 24 hours.
- Premium (1 req/sec, 500/day, full responses) requires an active **Hall of Fame** subscription. **Kyle has MVP, and MVP does not include premium API access — confirmed** from his own key page rendering an upgrade prompt.

### Terms

Personal, non-commercial. No product competing with FantasyPros (a private personal tracker is fine). Credit FantasyPros in anything published. **Player images require separate Sportradar permission — do not pull their headshots.** Full terms: `https://api.fantasypros.com/public/v2/terms-of-use`.

---

## STEP 3 — Measure truncation before designing anything

Free-tier responses are **truncated**. How much is the open question that decides whether this replaces the CSV paste or merely supplements it.

Kyle's Week 1 file carried 633 rows and his roster runs deep — Makai Lemon WR55, Kayshon Boutte WR62, Brian Robinson Jr. RB49. **If the free tier cuts at the top 25–30 per position, the API cannot replace the paste.**

**The probe:** WR and RB weekly rankings — report row count, the lowest-ranked player returned, and any truncation metadata. Plus one news call — do items carry timestamps and an `fpid`.

Report the numbers before writing integration code. Do not design around an assumption here.

---

## STEP 4 — News into the Scouting Report

This is the thing Kyle actually asked for. **It must be additive, not a swap.**

1. Render that player's FantasyPros news items in the modal's Scouting Report block, **newest first, each showing its date.**
2. Keep the seed note beneath as **"Preseason note (<date>)"** — dated, demoted, and **no longer labelled VERIFIED**.
3. Use the `category` filter. `injury`, `breaking`, and `transaction` are decision-relevant; `recap` is not.
4. Match items to players by `fpid` once Step 5 lands. Until then, match by name key and accept the miss rate — **do not invent a fuzzy matcher**, the app already has name-normalization defined in six places and that is a known problem, not a pattern to extend.

**Rule that governs this block: anything the UI presents as intel carries the date it was true.** Undated text implies "now." That rule is why the VERIFIED prefix comes off regardless of how good the content is.

**Do not delete the seed notes.** Some are genuinely more decision-useful than a recency-sorted feed — a camp report with a coach's quote beats a transaction blurb. Fresh is not the same as useful, and swapping one for the other is a downgrade in disguise.

---

## STEP 5 — `players`: canonical IDs

`GET /v2/json/nfl/players` returns FantasyPros IDs with **external-ID cross-references**.

This is quietly the highest-value endpoint. The roster matcher needed hand-fixing from 11/16 to 16/16. `rosterSearch` is defined three times. Name normalization lives in six places. Duplicate-name player merging was a shipped bug. Canonical IDs end that entire class — and they also fix the ESPN ↔ Odds API matching the props pipeline depends on.

Build the id map, then route matching through it. Keep the name-based path as fallback for players the map misses.

---

## STEP 6 — `player-points`: ground truth for the ledger

`player-points` returns actual scored points across a week range. That is the calibration ledger's ground truth, currently hand-fed.

Wire it in and the ledger grades itself. This is what makes the projection-weighting work in `calibration.js` mean anything by Week 4 instead of Week 12.

---

## Guardrails

- **Keep the CSV paste path working** as fallback — for when the API is down, rate-limited, truncating, or the key lapses. On the free tier at least one of those is guaranteed. Do not remove the importer.
- **Blend, don't rank-order sources.** When FantasyPros and ESPN disagree, the app widens the range rather than picking a winner. Making FantasyPros easier to fetch must not promote it to sole truth.
- **Stars stay context-only.** `pointDistribution` deliberately ignores matchup stars because FantasyPros already prices the matchup into its projection. Fetching the grade automatically must not change that.
- **Don't add Footballguys as an independent expert source.** Its rankers are contributing experts *inside* FantasyPros ECR — counting both counts the same opinions twice and reads the duplication as agreement.
- **Whatever ships carries its date.**
- Tests fail before their fix. `npm run verify` green before each commit.
- If anything in this document turns out to be wrong about the code, say so and stop rather than building around it.
