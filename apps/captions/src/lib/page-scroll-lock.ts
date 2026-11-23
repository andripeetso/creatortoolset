/**
 * Settings is a non-modal dialog (the assistant's dock stays usable), so nothing kept a wheel from scrolling the page
 * behind it: over the backdrop, over the header, or when a pane reached its end (owner, 2026-11-22). While on, a wheel
 * that no box under the pointer can take is dropped. The page keeps its scrollbar, so nothing moves sideways.
 */
export function lockPageScroll(): () => void {
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !takesWheel(e.target, e.deltaX, e.deltaY)) e.preventDefault(); // ctrl: a pinch, the zoom
  };
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => window.removeEventListener("wheel", onWheel, { capture: true });
}

/** A box from `target` up, short of the page itself, that can still scroll the way the wheel turns. */
export function takesWheel(target: EventTarget | null, dx: number, dy: number): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (dy && /auto|scroll|overlay/.test(s.overflowY) && (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0)) return true;
    if (dx && /auto|scroll|overlay/.test(s.overflowX) && (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0)) return true;
  }
  return false;
}
