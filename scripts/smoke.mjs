// ============================================================================
// Render smoke test — run with `npm run smoke`.
//
// WHY THIS EXISTS: a temporal-dead-zone bug in StartSitLab blanked the tab in
// production while all 122 unit assertions passed. They test pure functions;
// the bug only existed once a component rendered. No amount of engine testing
// could have seen it.
//
// So: actually render every screen, with a realistic state, and fail on any
// throw. Uses react-dom/server (already a dependency) and esbuild (already
// present via vite) — no new packages, and it runs in ~2 seconds.
//
// It renders the real components, not mocks. useMemo bodies and dependency
// arrays execute, which is exactly where the crash lived. useEffect does not
// run under SSR, so this catches render-phase faults, not effect faults —
// stated plainly rather than oversold.
// ============================================================================

import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const OUT = "node_modules/.smoke/bundle.mjs";

// ---- minimal browser surface, before anything imports ----
const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.matchMedia = (q) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
globalThis.document = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
  documentElement: { scrollHeight: 2000, scrollWidth: 400 },
  body: { style: {} },
  getElementById: () => null,
  querySelector: () => null,
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.scrollTo = () => {};
globalThis.location = { search: "", href: "https://the-huddle-hq.vercel.app/" };
// Node 24 defines `navigator` as a getter-only global, so assignment throws.
Object.defineProperty(globalThis, "navigator", {
  value: { maxTouchPoints: 0, clipboard: { writeText: async () => {} }, userAgent: "smoke" },
  configurable: true,
  writable: true,
});
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), headers: { get: () => null } });

let failures = 0;
const check = (name, fn) => {
  try {
    const out = fn();
    if (typeof out === "string" && out.length === 0) throw new Error("rendered empty output");
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e && e.message}`);
    if (e && e.stack) console.log(String(e.stack).split("\n").slice(1, 4).join("\n"));
  }
};

// ---- bundle the app for node ----
mkdirSync("node_modules/.smoke", { recursive: true });
await build({
  entryPoints: ["scripts/smoke-entry.jsx"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["import", "module", "default"],
  outfile: OUT,
  jsx: "automatic",
  loader: { ".css": "empty" },
  external: ["react", "react-dom", "react-dom/server"],
  logLevel: "error",
});

// resolve() + pathToFileURL, not manual string building — this path contains
// spaces and a comma on Windows and hand-rolled URLs mangle it.
const mod = await import(`${pathToFileURL(resolve(OUT)).href}?t=${Date.now()}`);
const { renderToString, React, App, screens, makeState } = mod;

console.log("=== render smoke test ===\n");

// The realistic state every screen is rendered against: full roster, live
// ESPN snapshot, an opponent, an OUT starter, a bench upgrade.
const state = makeState();

// 1. Every tab body, individually. This is the check that matters — the
//    crash lived in one tab and only fired when that tab mounted.
for (const [name, El, props] of screens(state)) {
  check(`renders ${name}`, () => renderToString(React.createElement(El, props)));
}

// 2. The whole app on each tab, through the real tree — App's own per-tab
//    memos (availablePool, watchIntelById, alerts) only run this way.
//    initialTab is required: the tab is internal state, so without it SSR
//    renders the default seven times and the test quietly checks nothing.
for (const tab of ["today", "roster", "lab", "intel", "watch", "waivers", "log"]) {
  check(`mounts <App/> on the "${tab}" tab`, () => {
    store.set("huddle-data", JSON.stringify({ ...state, week: "1" }));
    return renderToString(React.createElement(App, { initialTab: tab }));
  });
}

// 3. Degenerate states that have historically broken screens.
check("renders with an EMPTY state (first run, no sync)", () => {
  store.clear();
  return renderToString(React.createElement(App));
});
check("renders with espn present but an empty roster", () => {
  const s = makeState();
  s.players = {};
  for (const k of Object.keys(s.lineup)) s.lineup[k] = s.lineup[k].map(() => null);
  s.bench = s.bench.map(() => null);
  store.set("huddle-data", JSON.stringify(s));
  return renderToString(React.createElement(App));
});

rmSync("node_modules/.smoke", { recursive: true, force: true });
console.log(failures ? `\n${failures} SCREEN(S) FAILED TO RENDER` : "\nEvery screen rendered.");
process.exit(failures ? 1 : 0);
