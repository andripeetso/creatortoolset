import { useEffect, useState } from "react";
import { create } from "zustand";

/**
 * Chat mode: the assistant fills the left of the window (every chat in a list, the open one beside it) and the page the
 * open chat works on stands to its right. The page moves over by the chats' width (body padding, index.css:
 * html[data-chat-mode]) and lays out for the room it has left: <html data-pane> names the breakpoints it is narrower
 * than, and those turn off (postcss-pane.cjs), so each screen shows the layout it has for a window that wide. What a
 * screen leaves out beside the chats (its own chat, a list the chats replace) it says with the `chat:` variant
 * (tailwind.config.js) or useChatShown(). On or off, the width and whether the page shows are kept per browser.
 */

const KEY = "ct-chat-mode";
/** The chats list beside the open chat. */
export const LIST_W = 280;
/** The open chat's column at its narrowest. */
export const MIN_CHAT = 340;
/** The page at its narrowest: narrower, and the chats take the whole window. */
export const MIN_PAGE = 360;
/** The breakpoints the page's layouts are written for (tailwind's own). */
const BREAKPOINTS: Array<[string, number]> = [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];

type Stored = {
  on: boolean;
  /** The chats' width as dragged; 0 = half the window. */
  w: number;
  /** The page shows beside the chats (off: only chats). */
  page: boolean;
};

const stored = (): Stored => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Stored> | null;
    return { on: s?.on === true, w: typeof s?.w === "number" && s.w > 0 ? s.w : 0, page: s?.page !== false };
  } catch {
    return { on: false, w: 0, page: true };
  }
};

interface ChatModeState extends Stored {
  /** The chats are on screen now (the assistant draws them: not during setup, not signed out). Never stored. */
  shown: boolean;
  /** The page's width beside the chats while they show (0: only chats); null outside chat mode. Never stored. */
  pane: number | null;
  set: (patch: Partial<Stored>) => void;
}

export const useChatMode = create<ChatModeState>((set) => ({
  ...stored(),
  shown: false,
  pane: null,
  set: (patch) =>
    set((s) => {
      const next: Stored = { on: patch.on ?? s.on, w: patch.w ?? s.w, page: patch.page ?? s.page };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* it starts off next time */
      }
      return next;
    }),
}));

/** Whether the chats stand beside this page now: a screen leaves out what they replace only while they really show. */
export const useChatShown = (): boolean => useChatMode((s) => s.on && s.shown);

/**
 * Whether the page has at least `px` of width: the window's, less the chats beside it in chat mode. For a layout that
 * is decided in script; CSS breakpoints follow the page's room by themselves (postcss-pane.cjs).
 */
export function usePageMinWidth(px: number): boolean {
  const pane = useChatMode((s) => s.pane);
  const [win, setWin] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWin(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return (pane ?? win) >= px;
}

export interface ChatLayout {
  /** The chats' width. */
  chat: number;
  /** The chats take the whole window: the page is hidden. */
  full: boolean;
  /** The list stands beside the open chat: there is room for both (else it opens over the chat from its button). */
  list: boolean;
}

/** How the window `win` wide is shared. The page never gets less than MIN_PAGE nor the open chat less than MIN_CHAT. */
export function chatLayout(s: Pick<Stored, "w" | "page">, win: number): ChatLayout {
  const room = win - MIN_PAGE;
  const full = !s.page || room < MIN_CHAT;
  // half the window until the edge is dragged
  const chat = full ? win : Math.min(Math.max(s.w || Math.round(win / 2), MIN_CHAT), room);
  return { chat, full, list: chat - LIST_W >= MIN_CHAT };
}

/** The breakpoints a page `pane` wide is narrower than, as <html data-pane> carries them: "lt-lg lt-xl lt-2xl". */
export const paneBelow = (pane: number): string => BREAKPOINTS.filter(([, px]) => pane < px).map(([name]) => `lt-${name}`).join(" ");

/** The window's width less its scrollbar, where it has one: the chats' edge stays where it can be grabbed. */
const pageWidth = () => document.documentElement.clientWidth || window.innerWidth;

/**
 * For the one component that draws the chats (AssistantDock): the layout for this window, kept on <html> while `active`
 * (data-chat-mode, --chat-w, data-pane) so the page and its breakpoints follow, and `shown` in the store for the screens.
 */
export function useChatModeLayout(active: boolean): ChatLayout {
  const w = useChatMode((s) => s.w);
  const page = useChatMode((s) => s.page);
  const [win, setWin] = useState(pageWidth);
  useEffect(() => {
    const on = () => setWin(pageWidth());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const layout = chatLayout({ w, page }, win);
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.chatMode = layout.full ? "full" : "";
    root.style.setProperty("--chat-w", `${layout.chat}px`);
    if (layout.full) delete root.dataset.pane;
    else root.dataset.pane = paneBelow(win - layout.chat);
    useChatMode.setState({ shown: true, pane: layout.full ? 0 : win - layout.chat });
    return () => {
      delete root.dataset.chatMode;
      delete root.dataset.pane;
      root.style.removeProperty("--chat-w");
      useChatMode.setState({ shown: false, pane: null });
    };
  }, [active, layout.chat, layout.full, win]);
  return layout;
}

/** While the chats' edge is dragged: the page follows at once (the store takes the width when the drag ends). */
export function previewChatWidth(x: number): number {
  const win = pageWidth();
  const chat = Math.min(Math.max(x, MIN_CHAT), Math.max(MIN_CHAT, win - MIN_PAGE));
  const root = document.documentElement;
  root.style.setProperty("--chat-w", `${chat}px`);
  root.dataset.pane = paneBelow(win - chat);
  return chat;
}

/** ⌘J (Ctrl+J): chat mode on or off, from anywhere. */
export function useChatModeKey(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "j" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.repeat) return;
      e.preventDefault();
      // the button on screen now: the page bar's, or the one at the top of the chats
      toggleChatMode([...document.querySelectorAll<HTMLElement>("[data-chat-toggle]")].find((b) => b.getBoundingClientRect().width));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/**
 * Turn chat mode on or off from a button. Everything on screen gets a small push away from the button as a wave
 * passes it, then settles back (the switch itself is instant; the push only shows it happened).
 */
export function toggleChatMode(from?: HTMLElement | null): void {
  const { on, set } = useChatMode.getState();
  const r = from?.getBoundingClientRect();
  set({ on: !on });
  if (r && r.width) requestAnimationFrame(() => requestAnimationFrame(() => wave(r.left + r.width / 2, r.top + r.height / 2, !on)));
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
