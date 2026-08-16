// ============================================================================
// Storage module — localStorage-backed, mirrors the Claude artifact
// window.storage API shape so a real backend can swap in later without
// touching App code. Key: "huddle-data", value: JSON string of
// { starters, bench, watch, calls, faab, claims }.
// ============================================================================

export const HUDDLE_KEY = "huddle-data";

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
   * @returns {Promise<{key: string, value: string} | null>} null on failure
   */
  async set(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return { key, value };
    } catch {
      return null; // quota exceeded / private mode — App shows SAVE ERROR
    }
  },
};
