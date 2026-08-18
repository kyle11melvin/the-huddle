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

let raf = null;
let listening = false;
let pointer = { x: 0, y: 0 };
let target = null; // Element, or null meaning the document/window

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
};

/** Begin auto-scrolling for a drag that started on `el`. */
export function beginDragAutoScroll(el) {
  stopDragAutoScroll(); // never stack two loops
  target = findScrollParent(el);
  listening = true;
  // passive: this listener only reads coordinates; the row handlers do the
  // preventDefault that makes a drop legal.
  document.addEventListener("dragover", onDragOver, { passive: true });
  raf = requestAnimationFrame(step);
}

/**
 * Stop and fully tear down. Called on dragend, on drop, and on unmount — a
 * leaked rAF loop that keeps scrolling after the drop is worse than the bug
 * this fixes.
 */
export function stopDragAutoScroll() {
  listening = false;
  if (raf != null) cancelAnimationFrame(raf);
  raf = null;
  document.removeEventListener("dragover", onDragOver);
  target = null;
}
