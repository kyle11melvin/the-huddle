// ============================================================================
// Screenshot harness — renders the REAL components in real Chrome, writes PNGs.
//
//   node scripts/shots.mjs [outDir]
//
// Not part of `npm run verify` and not an app dependency: puppeteer-core is
// installed with --no-save and drives the Chrome already on this machine
// rather than downloading a second browser. Run it by hand when a visual
// change needs looking at.
//
// It server-renders the actual component through the same esbuild bundle
// smoke.mjs uses, then loads that HTML with the real stylesheet. An earlier
// version re-implemented the gauge markup inline, which is a copy that drifts
// from the thing it claims to show — the one failure mode that makes a
// screenshot worse than no screenshot.
//
// The smoke test proves a component RENDERS. This shows what it looks like,
// which is the part no assertion covers — the first pass passed every check
// while the needle sliced straight through the hero number.
// ============================================================================

import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { readFileSync as _rf } from "node:fs";
import { renderToString } from "react-dom/server";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT_DIR = process.argv[2] || "/tmp/huddle-shots";
const BUNDLE = "node_modules/.shots/bundle.mjs";
const CSS = readFileSync(resolve("src/index.css"), "utf8");

// Real numbers off the live roster, chosen to stress the geometry rather than
// flatter it. Bowers is the case where mean falls below his own floor.
// Player identity, ecr, status and notes are REAL records off the live team
// document; projections are real pointDistribution output. Props/matchup/
// consensus figures are illustrative — those feeds don't exist yet (see
// docs/DESIGN.md) — which is why one case deliberately shows the no-data state.
const CASES = [
  {
    file: "card-bijan.png",
    component: "card",
    palette: "current",
    props: {
      player: { name: "Bijan Robinson", pos: "RB", team: "ATL", opp: "@PIT", status: "", espnId: "4430807" },
      dist: { mean: 24.7, condMean: 24.7, sd: 13.5, playProb: 1 },
      propsEdge: { delta: 2.4, parts: ["18.5 rush att", "82.5 rush yds", "3.5 rec", "TD +135 (43%)"] },
      matchup: { grade: "B+", points: 2.1, detail: "PIT 24th vs RB" },
      consensus: { rank: "RB2", sources: 3, spread: 1 },
      book: { spread: "ATL +2.5", total: 44.5, implied: 21 },
      news: [
        { age: "2h", text: "Full participant Wednesday; no injury designation expected." },
        { age: "1d", text: "Signed extension the week of Aug 3 after briefly sitting out camp." },
      ],
    },
  },
  {
    file: "card-bowers.png",
    component: "card",
    palette: "current",
    props: {
      player: { name: "Brock Bowers", pos: "TE", team: "LV", opp: "vs MIA", status: "D", espnId: "4432665" },
      dist: { mean: 3.7, condMean: 14.9, sd: 8.9, playProb: 0.25 },
      propsEdge: null,
      matchup: { grade: "C", points: 0.4, detail: "MIA 16th vs TE" },
      consensus: { rank: "TE1", sources: 3, spread: 0 },
      book: null,
      news: [
        { age: "4h", text: "Limited again Thursday — coach calls him day to day." },
        { age: "2d", text: "Coordinator plans to use Bowers and Mayer together often." },
      ],
    },
  },
  { file: "gauge-bijan.png", component: "gauge", props: { mean: 24.7, condMean: 24.7, sd: 13.5, playProb: 1 } },
  { file: "gauge-bowers.png", component: "gauge", props: { mean: 3.7, condMean: 14.9, sd: 8.9, playProb: 0.25 } },
];

// ---- Gameday, with a live slate ----
// Kyle's REAL team document, with game state injected: tonight's games have
// not kicked off yet (00:35Z), so there is no genuinely live slate to shoot.
// Rosters, players and projections are real; the clock and the points scored
// are set here so the decay is visible.
function liveState() {
  const st = JSON.parse(_rf("/tmp/ka.json", "utf8")).state;
  const SLATE = {
    JAX: { pct: 0.55, detail: "Q2 07:21" },   // mid-game
    ATL: { pct: 0.12, detail: "Q4 04:50" },   // nearly done, big day banked
    CIN: { pct: 0, detail: "Final", post: true },
    LAR: { pct: 0.78, detail: "Q1 11:02" },   // just started
    IND: { pct: 0.4, detail: "Q3 09:40" },
  };
  for (const [abbr, g] of Object.entries(SLATE)) {
    st.espn.games[abbr] = {
      state: g.post ? "post" : "in",
      pctRemaining: g.pct,
      detail: g.detail,
      startTime: st.espn.games[abbr] ? st.espn.games[abbr].startTime : null,
    };
  }
  const SCORED = {
    "Trevor Lawrence": 6.4,
    "Bijan Robinson": 19.8,
    "Tee Higgins": 11.2,
    "Chase Brown": 2.1,
  };
  for (const t of st.espn.teams) {
    for (const e of t.roster || []) {
      if (SCORED[e.name] != null) e.actual = SCORED[e.name];
    }
  }
  return st;
}

// Same real roster, but with the opponent absent from the espn blob — the
// case where the old UI claimed "real ESPN projections" while running rank
// estimates. Also ages the sync past the staleness line.
function unsyncedState() {
  const st = liveState();
  st.espn.teams = st.espn.teams.filter((t) => (t.mapped || t.name) === "Brock Hard");
  st.espn.fetchedAt = Date.now() - 26 * 3600 * 1000;
  return st;
}

// Same card, reference palette — the only difference is the token block.
for (const base of CASES.filter((c) => c.component === "card" && c.palette === "current")) {
  CASES.push({ ...base, file: base.file.replace(".png", "-ref.png"), palette: "ref" });
}

CASES.push({
  file: "gameday-unsynced.png",
  component: "gameday",
  props: { state: unsyncedState(), week: "1", onSetLive: () => {}, onSetOpponent: () => {}, onRefresh: () => {} },
});

CASES.push({
  file: "gameday-live.png",
  component: "gameday",
  props: { state: liveState(), week: "1", onSetLive: () => {}, onSetOpponent: () => {}, onRefresh: () => {} },
});

mkdirSync("node_modules/.shots", { recursive: true });
await build({
  entryPoints: ["scripts/shots-entry.jsx"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["import", "module", "default"],
  outfile: BUNDLE,
  jsx: "automatic",
  loader: { ".css": "empty" },
  external: ["react", "react-dom", "react-dom/server"],
  logLevel: "error",
});
const { ProjectionGauge, PlayerCard, Gameday } = await import(`${pathToFileURL(resolve(BUNDLE)).href}?t=${Date.now()}`);
const COMPONENTS = { gauge: ProjectionGauge, card: PlayerCard, gameday: Gameday };

mkdirSync(OUT_DIR, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 700, deviceScaleFactor: 2 });

for (const c of CASES) {
  const markup = renderToString(React.createElement(COMPONENTS[c.component], c.props));
  const html = `<!doctype html><html><head>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Oswald:wght@600;700&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
    <style>${CSS}
      /* Kill entry animations. The app fades rows and panels in on mount, and
         a screenshot taken mid-flight renders the whole screen dimmed — which
         reads as a styling bug that isn't there. Visual checks want the
         settled state, deterministically. */
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
      body { background: var(--bg); padding: 22px 24px; font-family: var(--font-body); }
      .shot-label { color: var(--text-muted); font-size: 10px; letter-spacing: .18em;
        text-transform: uppercase; margin-bottom: 18px; font-weight: 700; }
    </style></head><body>
    <div class="${c.palette === "ref" ? "pal-ref" : ""}">${markup}</div>
  </body></html>`;

  // networkidle0 never settles here — the Google Fonts connection stays warm.
  // Wait for load, then for the webfonts, which is what actually has to finish
  // before the shot is worth taking.
  await page.setContent(html, { waitUntil: "load", timeout: 15000 });
  // This callback is serialised and run inside Chrome, not in node — `document`
  // is the page's, which eslint has no way to know from a scripts/ file.
  // eslint-disable-next-line no-undef
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT_DIR}/${c.file}`, fullPage: true });
  console.log("wrote", `${OUT_DIR}/${c.file}`);
}

await browser.close();
console.log(`\ndone — ${CASES.length} shots in ${OUT_DIR}`);
