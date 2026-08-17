// ============================================================================
// Shared gate for the routes that spend something real — ESPN cookies, the
// ability to rewrite a live lineup, or metered API credits.
//
// The threat model is not "a browser on the wrong origin". CORS only ever
// constrains browsers; curl ignores it entirely. The TOKEN is the control
// that actually protects these routes. The origin allowlist is defence in
// depth for the browser case, and it's what stops a random page you visit
// from reading your private league out of an authenticated session.
//
// HUDDLE_WRITE_TOKEN lives ONLY in Vercel's environment. It is never read
// from import.meta.env (that would bake it into the public client bundle),
// never logged, and never written to a file in this repo.
// ============================================================================

import crypto from "node:crypto";

// Production origin + the Vite dev server, so the DEV prod-proxy fallback in
// src/espnSync.js and src/espnWrite.js keeps working.
const DEFAULT_ORIGINS = ["https://the-huddle-hq.vercel.app", "http://localhost:5173"];

export function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ORIGINS;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

/**
 * Echo the caller's Origin back ONLY when it's on the allowlist. An
 * off-list origin gets no ACAO header at all, which is what makes the
 * browser refuse the response — never `*`, which grants every site.
 */
export function applyCors(req, res, methods = "GET,OPTIONS") {
  const origin = req.headers && req.headers.origin;
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // The response varies by Origin even when we send no ACAO — say so, or a
  // cache could hand an allowed origin's response to a disallowed one.
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-huddle-token");
}

/**
 * Constant-time bearer check against HUDDLE_WRITE_TOKEN.
 * Fails CLOSED: an unset env var denies everything rather than falling open,
 * so a misconfigured deploy is broken-but-safe instead of silently public.
 */
export function isAuthorized(req) {
  const expected = process.env.HUDDLE_WRITE_TOKEN;
  if (typeof expected !== "string" || expected.length === 0) return false;

  const raw = req.headers && req.headers["x-huddle-token"];
  const got = Array.isArray(raw) ? raw[0] : raw;
  if (typeof got !== "string" || got.length === 0) return false;

  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch — compare lengths first and
  // return false rather than letting it throw a 500.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 401 in the shape every route already returns errors in. */
export function sendUnauthorized(res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.status(401).send(JSON.stringify({ ok: false, error: "Unauthorized" }));
}

/**
 * Reject unknown query params.
 *
 * The CDN cache key is the full URL, so `?x=1`, `?x=2`, … are distinct keys
 * that each miss cache and re-run the handler — which is how a cache-only
 * budget guard gets drained in a minute. Unknown params are rejected before
 * any work happens, so the only cacheable URLs are the handful we define.
 *
 * @returns {boolean} true when the request is clean (caller continues)
 */
export function rejectUnknownParams(req, res, allowed) {
  const ok = new Set(allowed);
  const q = (req && req.query) || {};
  const bad = Object.keys(q).filter((k) => !ok.has(k));
  if (!bad.length) return true;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(400).send(
    JSON.stringify({
      ok: false,
      error: `Unexpected query parameter${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}`,
    })
  );
  return false;
}

/** Every outbound fetch gets a deadline; Node's fetch has no default. */
export const TIMEOUT_MS = 5000;
export const WRITE_TIMEOUT_MS = 8000;

/** True when a rejected fetch was our own timeout rather than a network fault. */
export const isAbort = (err) =>
  !!err && (err.name === "TimeoutError" || err.name === "AbortError");
