// ============================================================================
// The Huddle write token, client side.
//
// Deliberately localStorage and NOT import.meta.env: anything under
// VITE_* is inlined into the public JS bundle at build time, so shipping the
// token that way would publish the very secret that protects the ESPN write
// route. Keeping it in localStorage means it lives on the devices you paste
// it into and never enters the repo, the build, or a deploy artifact.
// ============================================================================

const KEY = "huddle-token";

/** @returns {string} the stored token, or "" when unset/unavailable. */
export function getToken() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return ""; // private mode / storage disabled
  }
}

/** Store (or clear, when passed an empty value) the token. */
export function setToken(value) {
  const clean = (value || "").trim();
  try {
    if (clean) localStorage.setItem(KEY, clean);
    else localStorage.removeItem(KEY);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Couldn't save the token: ${e.message}` };
  }
}

export const hasToken = () => getToken().length > 0;

/** The one message every caller shows when the token is missing. */
export const NO_TOKEN_ERROR = "No Huddle token set — paste it in Import & share → Huddle write token.";

/**
 * Auth headers for a Huddle API call, or null when no token is stored.
 * Callers surface NO_TOKEN_ERROR rather than firing a request that can only
 * come back 401 — a clear instruction beats a generic network failure.
 */
export function authHeaders() {
  const t = getToken();
  return t ? { "x-huddle-token": t } : null;
}
