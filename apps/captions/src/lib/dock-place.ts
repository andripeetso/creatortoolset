/**
 * Where the assistant sits (components/assistant): a corner of the window (the bubble, and the chat card floating
 * over the page) or docked to the right edge as a full-height panel that moves the page aside (not the left: the
 * corner buttons live there). You drag it there or throw it; it settles on the nearest place. Kept per browser in
 * localStorage, never as pixels, so a resized window can't strand it off screen. Chat mode (lib/chat-mode.ts) is the
 * other way to have it beside the page: on the left, with every chat.
 */

export type Corner = "tl" | "tr" | "bl" | "br";
export type Place = { mode: "float"; corner: Corner } | { mode: "dock" };

const KEY = "ct-assistant:place";
export const DEFAULT_PLACE: Place = { mode: "float", corner: "br" };

export function storedPlace(): Place {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null") as Place | null;
    if (p?.mode === "float" && ["tl", "tr", "bl", "br"].includes(p.corner)) return p;
    if (p?.mode === "dock") return p;
  } catch {
    /* private window or a bad value: start bottom right */
  }
  return DEFAULT_PLACE;
}

export function storePlace(p: Place): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* it just starts bottom right next time */
  }
}

/** A throw carries on this long (seconds of its release speed) before it settles. */
const THROW_S = 0.25;
/** Closer than this to the right edge docks the chat there. */
export const DOCK_EDGE = 24;

/**
 * Where a drag lands. (x, y) = the pointer at release, (vx, vy) = its speed in px/s, (w, h) = the window.
 * Only the chat card can dock (canDock); the bubble always goes to a corner.
 */
export function settle(x: number, y: number, vx: number, vy: number, w: number, h: number, canDock: boolean): Place {
  const px = x + vx * THROW_S;
  const py = y + vy * THROW_S;
  if (canDock && (x >= w - DOCK_EDGE || px >= w)) return { mode: "dock" };
  const corner = `${py < h / 2 ? "t" : "b"}${px < w / 2 ? "l" : "r"}` as Corner;
  return { mode: "float", corner };
}

/** The corner a docked chat's bubble goes back to when it's closed. */
export const cornerOf = (p: Place): Corner => (p.mode === "float" ? p.corner : "br");

/** The bubble's reach from the window's corner: its 16px gap, its 56px and a little air. */
const REACH = 96;

/** How high a box stands in the window's bottom right corner: from its top to the window's bottom, or 0 when the box
 *  is not in that corner (another layout put it elsewhere). */
export function cornerHeight(box: { top: number; right: number; bottom: number }, w: number, h: number): number {
  return w - box.right < REACH && h - box.bottom < REACH ? Math.max(0, Math.round(h - box.top)) : 0;
}

/**
 * For a screen's own box in the window's bottom right corner, where the bubble sits by default (a Review video's
 * comment box, a Workshop session's message box): given as the box's `ref`, it says how high the box stands
 * (--corner-taken and data-corner-taken on <html>). The bubble then sits above it instead of over its buttons
 * (AssistantDock), and the list above it keeps room at its end (.clears-bubble, index.css).
 */
export function cornerTaken(box: HTMLElement | null) {
  if (!box) return;
  const root = document.documentElement;
  const clear = () => {
    root.style.removeProperty("--corner-taken");
    delete root.dataset.cornerTaken;
  };
  const say = () => {
    const height = cornerHeight(box.getBoundingClientRect(), window.innerWidth, window.innerHeight);
    if (!height) return clear();
    root.style.setProperty("--corner-taken", `${height}px`);
    root.dataset.cornerTaken = "";
  };
  // the box's own size, and the page's: a page that grows moves a box that sticks to the bottom into the corner
  const sized = new ResizeObserver(say);
  sized.observe(box);
  sized.observe(document.body);
  window.addEventListener("resize", say);
  return () => {
    sized.disconnect();
    window.removeEventListener("resize", say);
    clear();
  };
}
