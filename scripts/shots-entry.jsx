// Entry point for the screenshot harness — re-exports the real components so
// esbuild bundles them exactly as the app builds them.
export { default as ProjectionGauge } from "../src/components/ProjectionGauge.jsx";
export { default as PlayerCard } from "../src/components/PlayerCard.jsx";
export { default as Gameday } from "../src/components/Gameday.jsx";
