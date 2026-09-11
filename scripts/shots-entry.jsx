// Entry bundled by scripts/shots.mjs — re-exports the real components so
// esbuild builds them exactly as the app does. A screenshot of a re-implemented
// copy is worse than no screenshot, so nothing here is a stand-in.
export { default as ProjectionGauge } from "../src/components/ProjectionGauge.jsx";
export { default as PlayerCard } from "../src/components/PlayerCard.jsx";
export { default as Gameday } from "../src/components/Gameday.jsx";
export { default as Today } from "../src/components/Today.jsx";
export { default as StartSitLab } from "../src/components/StartSitLab.jsx";
export { default as LeagueBrowser } from "../src/components/LeagueBrowser.jsx";
export { default as DataPanel } from "../src/components/DataPanel.jsx";
export { PlayerModal } from "../src/components/modals/index.jsx";
export { default as OpponentCard } from "../src/components/modals/OpponentCard.jsx";
