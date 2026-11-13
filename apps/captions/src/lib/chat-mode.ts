import { create } from "zustand";

/**
 * Chat mode: the assistant fills the left of the window (its chats, and the one open), the page you're on stands to
 * its right. The page moves over by the chats' width (body padding, index.css: html[data-chat-mode]); a page can lay
 * itself out for the narrower room with the `chat:` variant (tailwind.config.js). On or off, and how wide, are kept
 * per browser.
 */

const KEY = "ct-chat-mode";
/** Narrower than this, a drag of the edge ends chat mode. */
export const MIN_W = 460;
/** A page narrower than this is not worth showing: the chats take the whole window. */
export const MIN_PAGE = 320;

type Stored = { on: boolean; w: number };
const stored = (): Stored => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Stored> | null;
    return { on: s?.on === true, w: typeof s?.w === "number" ? s.w : 0 };
  } catch {
    return { on: false, w: 0 };
  }
};

interface ChatModeState extends Stored {
  set: (patch: Partial<Stored>) => void;
}

export const useChatMode = create<ChatModeState>((set) => ({
  ...stored(),
  set: (patch) =>
    set((s) => {
      const next = { on: patch.on ?? s.on, w: patch.w ?? s.w };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* it starts off next time */
      }
      return next;
    }),
}));

/** The chats' width in a window `win` wide: what was dragged, else half; all of it when the page would be too narrow. */
export function chatWidth(w: number, win: number): number {
  const want = w || Math.round(win / 2);
  if (win - want < MIN_PAGE) return win;
  return Math.max(MIN_W, want);
}

/**
 * Turn chat mode on or off from a button. Everything on screen gets a small push away from the button as a wave
 * passes it, then settles back (the switch itself is instant; the push only shows it happened).
 */
export function toggleChatMode(from?: HTMLElement | null): void {
  const { on, set } = useChatMode.getState();
  const r = from?.getBoundingClientRect();
  set({ on: !on });
  if (r) requestAnimationFrame(() => requestAnimationFrame(() => wave(r.left + r.width / 2, r.top + r.height / 2, !on)));
}

const PUSHED = "[data-appbar] > *, [data-chat-panel] li, [data-chat-panel] header > *, #root :is(section, article, li, h1, h2, img, video, [data-tile])";
/** How far the wave reaches per ms, and how far it pushes (px) right next to the button. */
const SPEED = 2.6;
const PUSH = 6;

export function wave(x: number, y: number, opening: boolean): void {
  if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const panel = document.querySelector<HTMLElement>("[data-chat-panel]");
  // opening: the chats show from the button outwards, a quick round reveal
  if (opening && panel?.animate) {
    const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const px = x - panel.getBoundingClientRect().left;
    panel.animate([{ clipPath: `circle(0px at ${px}px ${y}px)` }, { clipPath: `circle(${far}px at ${px}px ${y}px)` }], {
      duration: 380,
      easing: "cubic-bezier(.2,.8,.2,1)",
    });
  }
  const reach = Math.hypot(innerWidth, innerHeight);
  const els = [...document.querySelectorAll<HTMLElement>(PUSHED)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 8 && r.height > 8 && r.width * r.height < innerWidth * innerHeight * 0.4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)
    .slice(0, 160);
  for (const { el, r } of els) {
    const dx = r.left + r.width / 2 - x;
    const dy = r.top + r.height / 2 - y;
    const d = Math.hypot(dx, dy) || 1;
    const k = PUSH * (1 - 0.55 * Math.min(1, d / reach));
    const ux = (dx / d) * k;
    const uy = (dy / d) * k;
    el.animate(
      [
        { transform: "translate(0, 0)" },
        { transform: `translate(${ux}px, ${uy}px)`, offset: 0.3 },
        { transform: `translate(${-ux * 0.25}px, ${-uy * 0.25}px)`, offset: 0.65 },
        { transform: "translate(0, 0)" },
      ],
      // added to whatever transform the element has of its own (a centred dialog, a hover lift), never replacing it
      { duration: 520, delay: d / SPEED, easing: "ease-out", composite: "add" },
    );
  }
}
