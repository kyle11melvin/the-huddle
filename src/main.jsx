import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import "./index.css";

/**
 * A deliberate crash, on demand: open the app with ?selftest=boundary to
 * confirm the recovery screen actually works. Worth being able to check the
 * safety net BEFORE the Sunday you need it, and it costs two lines.
 */
function SelfTest({ children }) {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("selftest") === "boundary") {
    throw new Error("Self-test: this is a deliberate crash to verify the recovery screen.");
  }
  return children;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SelfTest>
        <App />
      </SelfTest>
    </ErrorBoundary>
  </React.StrictMode>
);
