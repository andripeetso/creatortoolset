// The Mac app glides a wheel mouse's steps (WheelGlide.swift). Over a canvas, timeline or viewer that pans and zooms by
// the wheel itself, a glide turns one step into many small ones, so those places carry `data-wheel="snap"` and this
// tells the app which kind of place the pointer is over ("snap" or "glide"), only when it changes. Outside the app
// (no "wheel" message handler) it adds nothing.
type Handler = { postMessage: (v: string) => void };

export function watchWheelPlaces(win: Window = window) {
  const app = (win as unknown as { webkit?: { messageHandlers?: { wheel?: Handler } } }).webkit?.messageHandlers?.wheel;
  if (!app) return;
  let last = "";
  const check = (e: Event) => {
    const now = (e.target as Element | null)?.closest?.('[data-wheel="snap"]') ? "snap" : "glide";
    if (now !== last) app.postMessage((last = now));
  };
  // a wheel step corrects it too: the page can change under a pointer that has not moved
  win.addEventListener("pointerover", check, { passive: true, capture: true });
  win.addEventListener("wheel", check, { passive: true, capture: true });
}
