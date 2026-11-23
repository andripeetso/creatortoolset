/**
 * Settings is a non-modal dialog (the assistant's dock stays usable), so nothing kept a wheel from scrolling the page
 * behind it: over the backdrop, over the header, or when a pane reached its end (owner, 2026-11-22). While on, a wheel
 * that no box under the pointer can take is dropped. The page keeps its scrollbar, so nothing moves sideways.
 */
export function lockPageScroll(): () => void {
  const onWheel = (e: WheelEvent) => {
    // only a mostly vertical wheel: a sideways one is the Mac app's swipe back (Shell.swift), and ctrl is a pinch, the zoom
    if (!e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !takesWheel(e.target, e.deltaY)) e.preventDefault();
  };
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => window.removeEventListener("wheel", onWheel, { capture: true });
}

/** A box from `target` up, short of the page itself, that can still scroll the way the wheel turns. */
export function takesWheel(target: EventTarget | null, dy: number): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (/auto|scroll|overlay/.test(getComputedStyle(el).overflowY) && (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0)) return true;
  }
  return false;
}
