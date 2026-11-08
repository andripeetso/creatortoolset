/**
 * Where the assistant sits (components/assistant): a corner of the window (the bubble, and the chat card floating
 * over the page) or docked to the right edge as a full-height panel that moves the page aside (not the left: the
 * corner buttons live there). You drag it there or throw it; it settles on the nearest place. Kept per browser in
 * localStorage, never as pixels, so a resized window can't strand it off screen.
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
