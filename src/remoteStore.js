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
  const r = await fetch(`/api/team?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `Sync read failed (${r.status})`);
  }
  return r.json();
}

export async function pushTeam(id, key, state) {
  const r = await fetch(`/api/team?id=${encodeURIComponent(id)}`, {
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
