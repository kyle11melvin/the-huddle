// ============================================================================
// Auto-scroll during a native HTML5 drag.
//
// Chrome is supposed to scroll the page when you drag a card toward the
// viewport edge. In practice it doesn't do it reliably, so dragging a bench
// player up to a starting slot that's scrolled off-screen simply stops at the
// top edge — you have to scroll first, then drag, which defeats the feature.
//
// This drives the scroll manually from the pointer position reported by
// `dragover` (the only pointer signal a native drag emits). The scroll target
// is resolved by walking up from the dragged element: modals and the league
// browser have their own overflow containers, so scrolling `window`
// unconditionally would be wrong there.
// ============================================================================

const EDGE = 80; // px from the edge where scrolling kicks in
const MAX_SPEED = 20; // px per frame at the very edge
// A live drag emits dragover continuously (the spec says ~every 350ms even
// when stationary). If we go this long without one, the gesture died without
// telling us — which is exactly what happens when iOS turns a long-press drag
// back into a scroll. Measured before this guard existed: the loop kept
// scrolling until it hit the top of the page and pinned there.
const STALL_MS = 1200;

let raf = null;
let listening = false;
let pointer = { x: 0, y: 0 };
let lastMove = 0;
let target = null; // Element, or null meaning the document/window
let onEndCb = null;

const canScrollY = (el) => {
  const cs = getComputedStyle(el);
  return /auto|scroll|overlay/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
};
const canScrollX = (el) => {
  const cs = getComputedStyle(el);
  return /auto|scroll|overlay/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2;
};

/** Nearest scrollable ancestor, or null when the document itself scrolls. */
function findScrollParent(el) {
  let node = el && el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    if (canScrollY(node) || canScrollX(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/** Ease in: 0 at the edge of the zone, 1 when the pointer is at the very edge. */
const ramp = (distanceIntoZone) => Math.min(1, Math.max(0, distanceIntoZone / EDGE)) ** 2;

function step() {
  if (!listening) return;
  // Watchdog: stop scrolling if the drag went quiet. Deliberately does NOT
  // end the drag itself — a browser that simply stopped emitting dragover
  // mid-gesture shouldn't have the user's move cancelled out from under them.
  if (lastMove && Date.now() - lastMove > STALL_MS) {
    stopDragAutoScroll();
    return;
  }
  const { x, y } = pointer;

  let top;
  let bottom;
  let left;
  let right;
  if (target) {
    const r = target.getBoundingClientRect();
    top = r.top;
    bottom = r.bottom;
    left = r.left;
    right = r.right;
  } else {
    top = 0;
    bottom = window.innerHeight;
    left = 0;
    right = window.innerWidth;
  }

  let dy = 0;
  if (y < top + EDGE) dy = -MAX_SPEED * ramp(top + EDGE - y);
  else if (y > bottom - EDGE) dy = MAX_SPEED * ramp(y - (bottom - EDGE));

  let dx = 0;
  const horizontal = target ? canScrollX(target) : document.documentElement.scrollWidth > window.innerWidth;
  if (horizontal) {
    if (x < left + EDGE) dx = -MAX_SPEED * ramp(left + EDGE - x);
    else if (x > right - EDGE) dx = MAX_SPEED * ramp(x - (right - EDGE));
  }

  if (dy || dx) {
    if (target) target.scrollBy(dx, dy);
    else window.scrollBy(dx, dy);
  }
  raf = requestAnimationFrame(step);
}

const onDragOver = (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  lastMove = Date.now();
};

/** The gesture is definitively over — stop scrolling AND clear drag state. */
const endGesture = () => {
  const cb = onEndCb;
  stopDragAutoScroll();
  if (cb) cb();
};
const onHidden = () => {
  if (document.visibilityState === "hidden") endGesture();
};

/**
 * Begin auto-scrolling for a drag that started on `el`.
 * @param {Function} [onEnd] called when the gesture ends by any route, so the
 *        caller can clear its own drag state rather than leaving a card stuck
 *        in a "dragging" style forever.
 */
export function beginDragAutoScroll(el, onEnd) {
  stopDragAutoScroll(); // never stack two loops
  target = findScrollParent(el);
  onEndCb = onEnd || null;
  listening = true;
  lastMove = Date.now();
  // passive: this listener only reads coordinates; the row handlers do the
  // preventDefault that makes a drop legal.
  document.addEventListener("dragover", onDragOver, { passive: true });
  // Belt and braces. `dragend` is the documented end of a drag, but under
  // touch — where the browser may abandon the drag and resume scrolling —
  // it is not reliably delivered, so the touch-native end events are watched
  // too. Every path here is idempotent.
  document.addEventListener("dragend", endGesture, true);
  document.addEventListener("drop", stopDragAutoScroll, true);
  document.addEventListener("touchend", endGesture, { passive: true });
  document.addEventListener("touchcancel", endGesture, { passive: true });
  document.addEventListener("visibilitychange", onHidden);
  raf = requestAnimationFrame(step);
}

/**
 * Stop and fully tear down. Called on dragend, on drop, on a stall, and on
 * unmount — a leaked rAF loop that keeps scrolling after the gesture is worse
 * than the bug this fixes. Measured: without this, one dragover near the top
 * edge with no dragend scrolled the page to 0 and held it there.
 */
export function stopDragAutoScroll() {
  listening = false;
  if (raf != null) cancelAnimationFrame(raf);
  raf = null;
  lastMove = 0;
  document.removeEventListener("dragover", onDragOver);
  document.removeEventListener("dragend", endGesture, true);
  document.removeEventListener("drop", stopDragAutoScroll, true);
  document.removeEventListener("touchend", endGesture);
  document.removeEventListener("touchcancel", endGesture);
  document.removeEventListener("visibilitychange", onHidden);
  target = null;
  onEndCb = null;
}
