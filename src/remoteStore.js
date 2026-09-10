// ============================================================================
// Live sync client.
//
// Layers on top of localStorage rather than replacing it: local stays the
// source of truth for instant reads and offline use, and the network is a
// best-effort mirror. If sync is off, or the request fails, the app behaves
// exactly as it did before.
//
// Writes are debounced because App saves on every state change — without it a
// burst of edits would be one PUT per keystroke.
// ============================================================================

const LINK_KEY = "huddle-link"; // { id, key, mode: "owner" | "viewer" }
const WRITE_DEBOUNCE_MS = 2500;

// Vite's dev server has no /api routes, so dev must talk to PRODUCTION — the
// same fallback espnSync.js, espnWrite.js and scheduleSync.js already use.
// This module was the one that never got it, so in dev every /api/team call
// hit localhost: the GET was served the api/team.js SOURCE as a JS module
// (200, text/javascript) and threw in r.json(), and the PUT 404'd. The read
// failure is why dev silently fell back to a stale localStorage copy.
//
// Read defensively: unlike the other modules, which evaluate import.meta.env
// inside a function that SSR never calls, these are module-level constants —
// and `import.meta.env` is undefined under the render smoke test's esbuild
// bundle, so a bare .DEV throws on import and takes every screen down with it.
const IS_DEV = !!(import.meta.env && import.meta.env.DEV);
const API_BASE = IS_DEV ? "https://the-huddle-hq.vercel.app" : "";

// ...but reads and writes do NOT get the same treatment. Reading production is
// what makes dev useful; writing to it is what makes dev dangerous. localhost
// carries its own localStorage copy that goes stale the moment anything
// changes on another device, and a push from here overwrites the real team
// document — scouting notes, ECR strings, claims, the call log — with that
// stale copy. There is no undo: the blob is the only server-side copy.
//
// So dev reads live and never writes. Enforced at BOTH write paths, because
// there are two: the debounced syncer below (fires on every edit) and
// goLive(), which calls pushTeam directly.
export const DEV_READ_ONLY = IS_DEV;
export const DEV_READ_ONLY_MSG =
  "Dev build — reading the live team, not writing to it. Your league copy is untouched.";

export function loadLink() {
  try {
    const raw = window.localStorage.getItem(LINK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLink(link) {
  try {
    if (link) window.localStorage.setItem(LINK_KEY, JSON.stringify(link));
    else window.localStorage.removeItem(LINK_KEY);
  } catch {
    /* private mode — sync just stays off */
  }
}

export function clearLink() {
  saveLink(null);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomString(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Short enough to text to your league, long enough not to collide. */
export const newTeamId = () => randomString(8);
/** Secret; never leaves this device except as a hash on the server. */
export const newWriteKey = () => randomString(32);

export async function fetchTeam(id) {
  const r = await fetch(`${API_BASE}/api/team?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `Sync read failed (${r.status})`);
  }
  return r.json();
}

export async function pushTeam(id, key, state) {
  // Backstop for the direct caller (goLive). The syncer refuses earlier, in
  // queue(), so a dev session doesn't generate a failed write per keystroke.
  if (DEV_READ_ONLY) throw new Error(DEV_READ_ONLY_MSG);
  const r = await fetch(`${API_BASE}/api/team?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Huddle-Key": key },
    body: JSON.stringify({ state }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `Sync write failed (${r.status})`);
  }
  return r.json();
}

/**
 * Debounced pusher. Collapses a burst of edits into a single PUT and reports
 * status transitions so the UI can show a live indicator.
 * @param {(status: "idle"|"saving"|"saved"|"error", detail?: string) => void} onStatus
 */
export function createSyncer(onStatus) {
  let timer = null;
  let pending = null;
  let inFlight = false;

  const flush = async () => {
    if (inFlight || !pending) return;
    const { id, key, state } = pending;
    pending = null;
    inFlight = true;
    onStatus("saving");
    try {
      await pushTeam(id, key, state);
      onStatus("saved");
    } catch (e) {
      onStatus("error", e.message);
    } finally {
      inFlight = false;
      if (pending) flush(); // a change landed mid-request
    }
  };

  return {
    queue(id, key, state) {
      // Refuse before anything is queued rather than letting flush() throw:
      // the caller queues on every state change, and a rejected write per
      // keystroke would flood the status badge with errors that aren't ones.
      // "readonly" is a distinct status, NOT "saved" — the badge must never
      // claim a write happened when none did.
      if (DEV_READ_ONLY) {
        onStatus("readonly", DEV_READ_ONLY_MSG);
        return;
      }
      pending = { id, key, state };
      clearTimeout(timer);
      timer = setTimeout(flush, WRITE_DEBOUNCE_MS);
    },
    flushNow() {
      clearTimeout(timer);
      return flush();
    },
    cancel() {
      clearTimeout(timer);
      pending = null;
    },
  };
}

/** Reads ?team=CODE from the URL (the new short share link). */
export function readTeamCodeFromUrl() {
  const m = /[?&]team=([a-z0-9]{6,32})\b/i.exec(window.location.search);
  return m ? m[1].toLowerCase() : null;
}

export function clearTeamCodeFromUrl() {
  if (window.location.search) {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

export function liveShareUrl(id, base) {
  const origin = base || `${window.location.origin}${window.location.pathname}`;
  return `${origin}?team=${id}`;
}
