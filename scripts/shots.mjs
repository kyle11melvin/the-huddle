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
const CASES = [
  { file: "gauge-bijan.png", label: "Bijan Robinson · RB · healthy", props: { mean: 24.7, condMean: 24.7, sd: 13.5, playProb: 1 } },
  { file: "gauge-bowers.png", label: "Brock Bowers · TE · 25% to play", props: { mean: 3.7, condMean: 14.9, sd: 8.9, playProb: 0.25 } },
  { file: "gauge-dicker.png", label: "Cameron Dicker · K · healthy", props: { mean: 10.9, condMean: 10.9, sd: 5.2, playProb: 1 } },
  { file: "gauge-lawrence.png", label: "Trevor Lawrence · QB · healthy", props: { mean: 23.1, condMean: 23.1, sd: 8.7, playProb: 1 } },
];

mkdirSync("node_modules/.shots", { recursive: true });
await build({
  entryPoints: ["src/components/ProjectionGauge.jsx"],
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
const { default: ProjectionGauge } = await import(`${pathToFileURL(resolve(BUNDLE)).href}?t=${Date.now()}`);

mkdirSync(OUT_DIR, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 380, deviceScaleFactor: 2 });

for (const c of CASES) {
  const markup = renderToString(React.createElement(ProjectionGauge, c.props));
  const html = `<!doctype html><html><head>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Oswald:wght@600;700&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
    <style>${CSS}
      body { background: var(--bg); padding: 22px 24px; font-family: var(--font-body); }
      .shot-label { color: var(--text-muted); font-size: 10px; letter-spacing: .18em;
        text-transform: uppercase; margin-bottom: 18px; font-weight: 700; }
    </style></head><body>
    <div class="shot-label">${c.label}</div>
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
  await page.screenshot({ path: `${OUT_DIR}/${c.file}` });
  console.log("wrote", `${OUT_DIR}/${c.file}`);
}

await browser.close();
console.log(`\ndone — ${CASES.length} shots in ${OUT_DIR}`);
