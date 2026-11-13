import { useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { create } from "zustand";

/**
 * Chat mode: the assistant fills the left of the window (every chat in a list, the open one beside it) and the page the
 * open chat works on stands to its right. The page moves over by the chats' width (body padding, index.css:
 * html[data-chat-mode]) and lays out for the room it has left: <html data-pane> names the breakpoints it is narrower
 * than, and those turn off (postcss-pane.cjs), so each screen shows the layout it has for a window that wide. What a
 * screen leaves out beside the chats (its own chat, a list the chats replace) it says with the `chat:` variant
 * (tailwind.config.js) or useChatShown(); a screen that cannot work in half a window says how much it needs
 * (usePageNeeds) and the chats give way. A new chat has no page: it starts as only chats (`bare`) and its page comes
 * beside it when it makes something. On or off, the width and whether the page shows are kept per browser.
 */

const KEY = "ct-chat-mode";
/** The chats list beside the open chat. */
export const LIST_W = 280;
/** The open chat's column at its narrowest. */
export const MIN_CHAT = 340;
/** The page at its narrowest (the sm breakpoint: a page beside the chats is never laid out as on a phone). A window with
 *  no room for this beside the chat shows only chats. */
export const MIN_PAGE = 640;
/** The breakpoints the page's layouts are written for (tailwind's own). */
const BREAKPOINTS: Array<[string, number]> = [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];

type Stored = {
  on: boolean;
  /** The chats' width as dragged; 0 = half the window. */
  w: number;
  /** The page shows beside the chats (off: only chats). Your own choice: the bar's button. */
  page: boolean;
  /**
   * The open chat has no page yet: a new chat, until it makes something, a link is followed or the page is asked for.
   * Only chats then, whatever `page` says. Kept so a reload paints the same screen at once.
   */
  bare: boolean;
};

const stored = (): Stored => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Stored> | null;
    return { on: s?.on === true, w: typeof s?.w === "number" && s.w > 0 ? s.w : 0, page: s?.page !== false, bare: s?.bare === true };
  } catch {
    return { on: false, w: 0, page: true, bare: false };
  }
};

interface ChatModeState extends Stored {
  /** The chats are on screen now (the assistant draws them: not during setup, not signed out). Never stored. */
  shown: boolean;
  /** The page's width beside the chats while they show (0: only chats); null outside chat mode. Never stored. */
  pane: number | null;
  /** How wide the screen on show says it has to be to work (usePageNeeds); 0 when it says nothing. Never stored. */
  need: number;
  set: (patch: Partial<Stored>) => void;
}

export const useChatMode = create<ChatModeState>((set) => ({
  ...stored(),
  shown: false,
  pane: null,
  need: 0,
  set: (patch) =>
    set((s) => {
      const next: Stored = { on: patch.on ?? s.on, w: patch.w ?? s.w, page: patch.page ?? s.page, bare: patch.bare ?? s.bare };
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

/**
 * For a screen that cannot work in half a window (an editor with panels on both sides of its picture): the width it
 * needs. In chat mode the chats give way down to their least so the page gets it, where the window has it.
 */
export function usePageNeeds(px: number): void {
  useEffect(() => {
    if (!px) return;
    useChatMode.setState({ need: px });
    return () => useChatMode.setState({ need: 0 });
  }, [px]);
}

export interface ChatLayout {
  /** The chats' width. */
  chat: number;
  /** The chats take the whole window: the page is hidden. */
  full: boolean;
  /** Hidden because the window has no room for the page beside the chat, not because it was asked for. */
  forced: boolean;
  /** The list stands beside the open chat: there is room for both (else it opens over the chat from its button). */
  list: boolean;
}

/**
 * How the window `win` wide is shared. The page never gets less than MIN_PAGE nor the open chat less than MIN_CHAT;
 * `need` is what the screen on show asks for itself (usePageNeeds), given as far as the chat's least allows.
 */
export function chatLayout(s: Pick<Stored, "w" | "page"> & { bare?: boolean }, win: number, need = 0): ChatLayout {
  const forced = win - MIN_PAGE < MIN_CHAT;
  const full = !s.page || forced || !!s.bare;
  const room = win - Math.max(MIN_PAGE, Math.min(need, win - MIN_CHAT));
  // half the window until the edge is dragged
  const chat = full ? win : Math.min(Math.max(s.w || Math.round(win / 2), MIN_CHAT), room);
  return { chat, full, forced, list: chat - LIST_W >= MIN_CHAT };
}

/**
 * Whether the open chat has no page (`bare`), given what it was. A chat nothing was said in has none; neither has it
 * after its first message (sending moves nothing: what ends it is something made, a link, the page's button). Another
 * chat on show is a new one or one that was started. Outside chat mode a chat is about the page on screen, so only a
 * chat nothing was said in is bare.
 */
export const bareNow = (was: boolean, s: { chatMode: boolean; another: boolean; unsent: boolean }): boolean =>
  !s.chatMode || s.another || s.unsent ? s.unsent : was;

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
  const bare = useChatMode((s) => s.bare);
  const need = useChatMode((s) => s.need);
  const [win, setWin] = useState(pageWidth);
  useEffect(() => {
    const on = () => setWin(pageWidth());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const layout = chatLayout({ w, page, bare }, win, need);
  // before the browser draws: a switch is one picture of the old screen and one of the new (washTo)
  useLayoutEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.chatMode = layout.full ? "full" : "";
    // a page that is not drawn is not heard either
    if (layout.full) for (const m of document.querySelectorAll<HTMLMediaElement>("main video, main audio")) m.pause();
    // the list beside the chat carries the app's name and the account (index.css)
    root.toggleAttribute("data-chat-list", layout.list);
    root.style.setProperty("--chat-w", `${layout.chat}px`);
    if (layout.full) delete root.dataset.pane;
    else root.dataset.pane = paneBelow(win - layout.chat);
    useChatMode.setState({ shown: true, pane: layout.full ? 0 : win - layout.chat });
    return () => {
      delete root.dataset.chatMode;
      delete root.dataset.pane;
      root.removeAttribute("data-chat-list");
      root.style.removeProperty("--chat-w");
      useChatMode.setState({ shown: false, pane: null });
    };
  }, [active, layout.chat, layout.full, layout.list, win]);
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

/** Turn chat mode on or off from its button (⌘J: the one on screen): the one switch that is shown with the wash. */
export function toggleChatMode(from?: HTMLElement | null): void {
  washTo({ on: !useChatMode.getState().on }, from, { wash: true });
}

/** How long the front takes to cross the window (ms). */
export const WASH = 900;
/** How wide the soft rim is where the two screens meet (px; index.css has the same number). */
const RIM = 220;
/** How strong the light on the front is, 0 (none) to 1. Quiet by choice: it was turned up once and read as a toy. */
const LIGHT = 0.5;
/** How much larger than life the new screen is as the front first shows it; it settles to its size, toward the button. */
const DRAWN = 1.012;
/** How far across its reach the front is (0 to 1) at `t` (0 to 1): it takes a moment to get going and finishes fast. */
export const frontAt = (t: number): number => t ** 2;

/** The switch on its way and what it changes. */
let washing: { skipTransition(): void } | null = null;
let washingTo: Partial<Stored> = {};

/** A switch cut short by another one: its light goes at once, with it. */
function cutShort(): void {
  washing?.skipTransition();
  for (const el of document.querySelectorAll(".chat-wash-light")) el.remove();
}

/** The middle of `el`, or of the chat-mode button on screen. */
function middleOf(el?: Element | null): { x: number; y: number } | null {
  const r = (el ?? [...document.querySelectorAll("[data-chat-toggle]")].find((b) => b.getBoundingClientRect().width))?.getBoundingClientRect();
  return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

/**
 * Change how chat mode shares the window (on or off, the page shown or hidden); `also` is what else changes in the
 * same breath (the chat on show). The change is there at once, with no effect, for everything but one switch.
 *
 * `wash`: chat mode itself turned on or off, from its button or ⌘J. Only then the screen as it was stays where it is
 * and the new one washes over it from the button outwards, through a wide soft rim, in one movement that takes a
 * moment to get going and finishes fast, with a soft band of light in the project's colour on the front. The new
 * screen settles to its size as one, toward the button: nothing in it moves on its own. With no button (⌘J on a screen
 * whose bar has none) it starts where the button stands. Any change while it runs, or where motion is turned down,
 * and the new screen is there at once.
 *
 * The page shown or hidden beside the chats, a new chat, a chat's first page: those happen all day, and the wash on
 * each of them was too much.
 */
export function washTo(patch: Partial<Stored>, from?: Element | null, how: { also?: () => void; wash?: boolean } = {}): void {
  const { set } = useChatMode.getState();
  // what else changes with the layout (another chat is opened) is part of the same new screen
  const change = () => {
    how.also?.();
    set(patch);
  };
  // asked for twice (a page opened by two things at once): the switch on its way is the answer
  if (washing && !how.also && (Object.keys(patch) as Array<keyof Stored>).every((k) => washingTo[k] === patch[k])) return;
  if (!how.wash || washing || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    cutShort();
    return change();
  }
  const pressed = middleOf(from);
  const go = (picture: string | null) => {
    // no button on screen: about where it stands in the chats' bar
    const { x, y } = pressed ?? middleOf() ?? { x: 28, y: 28 };
    wash(x, y, picture);
  };
  if (!document.startViewTransition) {
    // no picture of the old screen to wash over: the chats show from the button
    change();
    requestAnimationFrame(() => requestAnimationFrame(() => go(null)));
    return;
  }
  const root = document.documentElement;
  // index.css: while this class is on, the two pictures are not cross-faded and the new one has its round mask
  root.classList.add("chat-wash");
  // the screen has to be the new one by the time this returns (useChatModeLayout puts the layout on <html> in a
  // layout effect, so one synchronous render does it)
  const t = document.startViewTransition(() => flushSync(change));
  washing = t;
  washingTo = patch;
  t.ready.then(
    () => go("::view-transition-new(root)"),
    () => {},
  );
  void t.finished.finally(() => {
    washing = null;
    washingTo = {};
    root.classList.remove("chat-wash");
    // the mask's animation holds its last frame: it goes with the pictures
    for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition")) a.cancel();
  });
}

/**
 * The front from (x, y), crossing the window in WASH. `picture`: the pseudo-element that holds the new screen, shown
 * through a round mask that grows (index.css gives it the mask; its size and place are animated here) while the whole
 * of it settles to its size; null where there is no such picture, and the chats alone are shown from the button. On
 * the front rides the band of light (index.css .chat-wash-light), which leaves the window after the front has, fading.
 */
function wash(x: number, y: number, picture: string | null): void {
  const duration = WASH;
  const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  // the front is the middle of the rim; it ends half a rim past the window's far corner, which is then all new
  const reach = far + RIM / 2;
  const STEPS = 30;
  const at = Array.from({ length: STEPS + 1 }, (_, i) => reach * frontAt(i / STEPS));
  if (picture) {
    const frames = at.map((f) => {
      const s = `${2 * f + RIM}px`;
      const p = `${x - f - RIM / 2}px ${y - f - RIM / 2}px`;
      return { maskSize: `${s} ${s}`, maskPosition: p, webkitMaskSize: `${s} ${s}`, webkitMaskPosition: p };
    });
    document.documentElement.animate(frames, { duration, pseudoElement: picture, fill: "both" });
    // the new screen as one, a touch large at first and settling toward the button. Not each thing by itself: things
    // moved one by one go out of line with their neighbours
    const origin = `${x}px ${y}px`;
    document.documentElement.animate(
      [
        { transform: `scale(${DRAWN})`, transformOrigin: origin },
        { transform: "scale(1)", transformOrigin: origin },
      ],
      { duration, pseudoElement: picture, easing: "cubic-bezier(.2,.6,.2,1)", fill: "both" },
    );
  } else {
    const panel = document.querySelector<HTMLElement>("[data-chat-panel]");
    const px = x - (panel?.getBoundingClientRect().left ?? 0);
    panel?.animate?.(
      at.map((f) => ({ clipPath: `circle(${f}px at ${px}px ${y}px)` })),
      { duration },
    );
  }
  {
    // its rim is where the new screen is whole (it is drawn in that screen, which thins out across the rim). It comes
    // up as it grows and is all there once it is WIDE: small, the band would be a thin circle round the button
    const TAIL = 0.35;
    const BASE = 200;
    const WIDE = 420;
    const el = document.body.appendChild(document.createElement("div"));
    el.className = "chat-wash-light";
    Object.assign(el.style, { left: `${x - BASE}px`, top: `${y - BASE}px`, width: `${2 * BASE}px`, height: `${2 * BASE}px` });
    void el
      .animate(
        Array.from({ length: STEPS + 1 }, (_, i) => {
          const t = (i / STEPS) * (1 + TAIL);
          const r = Math.max(0, reach * frontAt(t) - RIM / 2);
          return { transform: `scale(${r / BASE})`, opacity: LIGHT * Math.min(1, r / WIDE) * (t <= 1 ? 1 : 1 - (t - 1) / TAIL) };
        }),
        { duration: duration * (1 + TAIL), fill: "both" },
      )
      .finished.then(
        () => el.remove(),
        () => el.remove(),
      );
  }
}
