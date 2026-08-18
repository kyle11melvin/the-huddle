// ============================================================================
// Storage module — localStorage-backed, mirrors the Claude artifact
// window.storage API shape so a real backend can swap in later without
// touching App code. Key: "huddle-data", value: JSON string of
// { starters, bench, watch, calls, faab, claims }.
// ============================================================================

export const HUDDLE_KEY = "huddle-data";
const PROBE_KEY = "huddle-probe";

/**
 * Can this browser actually persist a byte right now?
 *
 * Safari in private browsing is the trap: localStorage EXISTS and setItem
 * appears to work, then throws QuotaExceededError with a quota of zero. So a
 * one-byte write is the only honest test of writability — it separates "this
 * browser refuses to store anything" from "your data no longer fits".
 */
export function probeStorage() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return { ok: false, reason: "unavailable" };
    }
    window.localStorage.setItem(PROBE_KEY, "1");
    window.localStorage.removeItem(PROBE_KEY);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: classify(err, false), name: err && err.name };
  }
}

/** Error → cause. `canWriteTiny` decides "disk full" vs "refuses to store". */
function classify(err, canWriteTiny) {
  const name = (err && err.name) || "";
  const msg = String((err && err.message) || "");
  if (name === "SecurityError") return "blocked";
  if (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    /quota|exceeded/i.test(msg)
  ) {
    // A tiny write still working means the store is real and simply full.
    // A tiny write failing too means storage is switched off for this session.
    return canWriteTiny ? "full" : "private";
  }
  return "unknown";
}

/** Plain-English, phone-readable. No jargon, no DevTools required. */
export const STORAGE_MESSAGE = {
  private:
    "This browser can't save — private browsing is on. Anything you change here disappears when you close the tab. Reopen The Huddle in a normal window.",
  blocked:
    "This browser is blocking storage for this site, so nothing can be saved. Allow site data for the-huddle-hq.vercel.app in your privacy settings.",
  full: "This device is out of storage space, so your last change wasn't saved. Free up space and reload.",
  unavailable: "This browser has no local storage, so nothing can be saved here.",
  unknown: "Couldn't save to this device — your last change may not have been stored.",
};

export const storage = {
  /**
   * @param {string} key
   * @returns {Promise<{key: string, value: string} | null>}
   */
  async get(key) {
    try {
      const value = window.localStorage.getItem(key);
      if (value == null) return null;
      return { key, value };
    } catch {
      return null;
    }
  },

  /**
   * @param {string} key
   * @param {string} value
   * @returns {Promise<{ok: boolean, reason?: string, name?: string}>}
   *
   * Reports WHY a write failed rather than swallowing it. The old version
   * returned null on any error, so the banner said "SAVE ERROR" and the
   * failure erased its own cause — leaving nothing to chase later.
   */
  async set(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return { ok: true };
    } catch (err) {
      const tiny = probeStorage();
      return { ok: false, reason: classify(err, tiny.ok), name: err && err.name };
    }
  },
};
