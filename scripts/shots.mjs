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
const { ProjectionGauge, PlayerCard } = await import(`${pathToFileURL(resolve(BUNDLE)).href}?t=${Date.now()}`);
const COMPONENTS = { gauge: ProjectionGauge, card: PlayerCard };

mkdirSync(OUT_DIR, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });

for (const c of CASES) {
  const markup = renderToString(React.createElement(COMPONENTS[c.component], c.props));
  const html = `<!doctype html><html><head>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Oswald:wght@600;700&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
    <style>${CSS}
      body { background: var(--bg); padding: 22px 24px; font-family: var(--font-body); }
      .shot-label { color: var(--text-muted); font-size: 10px; letter-spacing: .18em;
        text-transform: uppercase; margin-bottom: 18px; font-weight: 700; }
    </style></head><body>
    ${markup}
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
