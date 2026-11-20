// The Mac app glides a wheel mouse's steps (WheelGlide.swift). Over a canvas, timeline or viewer that pans and zooms by
// the wheel itself, a glide turns one step into many small ones, so those places carry `data-wheel="snap"` and this
// tells the app which kind of place the pointer is over ("snap" or "glide"), only when it changes. Outside the app
// (no "wheel" message handler) it adds nothing.
type Handler = { postMessage: (v: string) => void };

export function watchWheelPlaces(win: Window = window) {
  const app = (win as unknown as { webkit?: { messageHandlers?: { wheel?: Handler } } }).webkit?.messageHandlers?.wheel;
  if (!app) return;
  let last = "";
  let at: { x: number; y: number } | null = null;
  const tell = (el: Element | null) => {
    const now = el?.closest?.('[data-wheel="snap"]') ? "snap" : "glide";
    if (now !== last) app.postMessage((last = now));
  };
  const check = (e: Event) => tell(e.target as Element | null);
  win.addEventListener("pointerover", check, { passive: true, capture: true });
  win.addEventListener("pointermove", (e) => (at = { x: (e as PointerEvent).clientX, y: (e as PointerEvent).clientY }), {
    passive: true,
    capture: true,
  });
  // a wheel step corrects it too
  win.addEventListener("wheel", check, { passive: true, capture: true });
  // the page can change under a pointer that has not moved (a new route, a canvas or dialog appearing), and the first
  // wheel step would still go the old way: look again at the pointer's place whenever the page's elements change
  new MutationObserver(() => at && tell(win.document.elementFromPoint(at.x, at.y))).observe(win.document.documentElement, {
    childList: true,
    subtree: true,
    attributeFilter: ["data-wheel"],
  });
}
