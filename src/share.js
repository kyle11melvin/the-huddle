// ============================================================================
// Share-by-URL snapshot.
//
// localStorage is per-device, so a bare link shows visitors the seed roster,
// not yours. This encodes your live state into the URL fragment so anyone who
// opens the link sees YOUR team — no backend, no accounts.
//
// It is a SNAPSHOT, not live sync: the link freezes the moment you generated
// it. Re-share after changes. (Real-time shared state needs a server-side
// store; this is the zero-infrastructure version.)
//
// Size control: scouting notes that still match the bundled seed text are
// stripped and rebuilt on the other side from the player id, which is most of
// the payload. The derived ECR index is dropped entirely.
// ============================================================================

import { SEED_STARTERS, SEED_BENCH } from "./data/seeds.js";

const SEED_NOTES = (() => {
  const m = {};
  for (const p of [...SEED_STARTERS, ...SEED_BENCH]) m[p.id] = p.notes || "";
  return m;
})();

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Strip anything reconstructible or derived. */
export function packState(state) {
  const players = {};
  for (const [id, p] of Object.entries(state.players || {})) {
    const copy = { ...p };
    if (SEED_NOTES[id] != null && copy.notes === SEED_NOTES[id]) delete copy.notes;
    if (!copy.notes) delete copy.notes;
    if (!copy.status) delete copy.status;
    if (!copy.espnId) delete copy.espnId;
    if (copy.weeks && Object.keys(copy.weeks).length === 0) delete copy.weeks;
    players[id] = copy;
  }
  const out = {
    v: 2,
    week: state.week,
    players,
    lineup: state.lineup,
    bench: state.bench,
    ir: state.ir,
    watch: state.watch,
    calls: state.calls,
    faab: state.faab,
    claims: state.claims,
  };
  if (state.byes && Object.keys(state.byes).length) out.byes = state.byes;
  // state.espn and state.schedule are rebuildable from the API and far too
  // large for a URL
  return out;
}

export function unpackState(packed) {
  const players = {};
  for (const [id, p] of Object.entries(packed.players || {})) {
    players[id] = {
      espnId: "",
      status: "",
      notes: SEED_NOTES[id] || "",
      weeks: {},
      ...p,
    };
  }
  return { ...packed, players };
}

export function encodeShare(state) {
  return b64urlEncode(JSON.stringify(packState(state)));
}

export function decodeShare(token) {
  const parsed = JSON.parse(b64urlDecode(token));
  return unpackState(parsed);
}

export function shareUrl(state, base) {
  const origin = base || `${window.location.origin}${window.location.pathname}`;
  return `${origin}#team=${encodeShare(state)}`;
}

/** Reads (and clears) a shared team from the current URL, if present. */
export function readShareFromUrl() {
  const hash = window.location.hash || "";
  const m = /[#&]team=([A-Za-z0-9\-_]+)/.exec(hash);
  if (!m) return null;
  try {
    return decodeShare(m[1]);
  } catch {
    return null;
  }
}

export function clearShareFromUrl() {
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}
