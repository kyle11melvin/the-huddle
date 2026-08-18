// ============================================================================
// The last line of defence.
//
// App renders straight off persisted state and remote JSON — migrate,
// applyEspnSync, pointDistribution, the simulators. A throw in any of them
// used to blank the page: white screen, no message, no way back. On a desktop
// that's an annoyance you can clear with DevTools. On a phone at 12:55 on a
// Sunday it is unrecoverable, and the corrupt data reloads with you.
//
// So: catch it, say what happened in plain words, and offer an escape hatch
// that clears the saved team WITHOUT clearing the write token — losing the
// token would mean re-pasting it from Vercel before the app could sync again,
// which is the last thing you need in that moment.
//
// Styles are inline on purpose. If the app is broken enough to land here, the
// stylesheet is not something to depend on.
// ============================================================================

import React from "react";
import { HUDDLE_KEY } from "./storage.js";

const wrap = {
  maxWidth: 560,
  margin: "40px auto",
  padding: "24px",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  color: "#e8edf7",
  background: "#141a26",
  border: "1px solid #2e3b58",
  borderRadius: 14,
  lineHeight: 1.55,
};
const btn = {
  display: "block",
  width: "100%",
  minHeight: 48,
  marginTop: 10,
  borderRadius: 10,
  border: "1px solid #2e3b58",
  background: "#1c2333",
  color: "#e8edf7",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
};

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, cleared: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the stack somewhere retrievable — the screen shows a summary, but
    // the console has the whole thing if it's ever needed.
    console.error("The Huddle crashed:", error, info && info.componentStack);
  }

  reset = () => {
    try {
      // The saved team goes. The write token stays: without it the app can't
      // sync, and re-pasting it mid-Sunday is exactly the wrong task.
      window.localStorage.removeItem(HUDDLE_KEY);
      this.setState({ cleared: true });
    } catch {
      /* storage unavailable — the reload below is still worth trying */
    }
  };

  render() {
    const { error, cleared } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={wrap}>
        <div style={{ fontSize: 12, letterSpacing: 1, color: "#8a97b1", textTransform: "uppercase" }}>
          The Huddle
        </div>
        <h1 style={{ fontSize: 22, margin: "6px 0 10px" }}>Something broke on this screen.</h1>
        <p style={{ margin: "0 0 6px", color: "#b9c3d6" }}>
          Your ESPN roster is safe — it lives in your ESPN account, not here. The only thing at risk is what this
          app stores on this device: scouting notes, the call log, claims and the calibration ledger.
        </p>
        <p style={{ margin: "0 0 14px", color: "#b9c3d6" }}>
          Try reloading first. If it keeps breaking, the saved data on this device is probably the cause — clearing
          it will fix that, and your next sync rebuilds the roster from ESPN.
        </p>

        {cleared ? (
          <p style={{ color: "#2ed584", fontWeight: 600 }}>
            Local data cleared. Reload to start fresh — your token is still set.
          </p>
        ) : null}

        <button style={btn} onClick={() => window.location.reload()}>
          Reload the app
        </button>
        <button style={btn} onClick={this.reset} disabled={cleared}>
          {cleared ? "Cleared ✓" : "Clear this device's saved data (keeps your token)"}
        </button>

        <details style={{ marginTop: 16, color: "#8a97b1", fontSize: 12 }}>
          <summary style={{ cursor: "pointer" }}>What went wrong (send me this)</summary>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              marginTop: 8,
              padding: 10,
              background: "#0a0e17",
              borderRadius: 8,
              fontSize: 11,
            }}
          >
            {String((error && error.stack) || error)}
          </pre>
        </details>
      </div>
    );
  }
}
