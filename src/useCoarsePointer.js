// ============================================================================
// "Is the user pointing with a finger?"
//
// Keyed on INPUT CAPABILITY, not screen width. A narrow desktop window still
// has a mouse and should keep drag-and-drop; a touchscreen laptop is wide and
// should get the tap affordance. `pointer: coarse` means the primary pointer
// is imprecise (finger, stylus); `hover: none` means it can't hover, which is
// why title-attribute affordances are invisible on those devices.
//
// This exists because native HTML5 drag-and-drop (draggable + dataTransfer)
// is UNRELIABLE under touch on iOS — not absent. Verified on a real iPhone:
// a long-press drag does sometimes complete and the move sticks, but the
// gesture competes with scrolling and frequently degrades into a scroll
// instead. An intermittent drag is more dangerous than a broken one, because
// a failed move is indistinguishable from a successful one until kickoff.
// ============================================================================

import { useEffect, useState } from "react";

const QUERY = "(pointer: coarse), (hover: none)";

const read = () => {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
};

export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(read);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia(QUERY);
    const onChange = (e) => setCoarse(e.matches);
    // Safari < 14 only has the deprecated addListener.
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  return coarse;
}
