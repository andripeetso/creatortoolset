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

/** Turn chat mode on or off from its button (⌘J: the one on screen). */
export function toggleChatMode(from?: HTMLElement | null): void {
  washTo({ on: !useChatMode.getState().on }, from);
}

/** How long the wash takes, from the press to the new screen all there (ms). */
export const WASH = 900;
/** How wide the front's soft rim is (px; index.css has the same number). */
const RIM = 120;
/** How far the front pushes what it passes (px, right next to the button). */
const PUSH = 12;
/** How long a pushed thing takes to settle (ms). */
const SETTLE = 640;
/** How far across its reach the front is (0 to 1) at `t` of the wash (0 to 1): a little quicker off the button than at the end. */
export const frontAt = (t: number): number => 1 - (1 - t) ** 1.35;
/** When (0 to 1 of the wash) the front is `d` of its reach away from the button: frontAt the other way round. */
export const frontReaches = (d: number): number => 1 - (1 - Math.min(1, Math.max(0, d))) ** (1 / 1.35);

/** The wash on screen now, if one is, and what it changes. */
let washing: { skipTransition(): void } | null = null;
let washingTo: Partial<Stored> = {};

/** The middle of `el`, or of the chat-mode button on screen. */
function middleOf(el?: Element | null): { x: number; y: number } | null {
  const r = (el ?? [...document.querySelectorAll("[data-chat-toggle]")].find((b) => b.getBoundingClientRect().width))?.getBoundingClientRect();
  return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

/**
 * Change how chat mode shares the window (on or off, the page shown or hidden) from a button; `also` is what else
 * changes in the same breath (the chat on show). The screen as it was
 * stays where it is and the new one washes over it from the button outwards, a soft-rimmed round front that crosses the
 * window in WASH; what the front passes is pushed a little away from the button and settles back. With no button
 * (⌘J on a screen whose bar has none) it starts where the button stands afterwards. Changed again while a wash runs, or
 * where motion is turned down, the new screen is there at once.
 */
export function washTo(patch: Partial<Stored>, from?: Element | null, also?: () => void): void {
  const { set } = useChatMode.getState();
  // what else changes with the layout (another chat is opened) is part of the same new screen
  const change = () => {
    also?.();
    set(patch);
  };
  // asked for twice (a page opened by two things at once): the wash on its way is the answer
  if (washing && !also && (Object.keys(patch) as Array<keyof Stored>).every((k) => washingTo[k] === patch[k])) return;
  if (washing || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    washing?.skipTransition();
    return change();
  }
  const pressed = middleOf(from);
  const go = (picture: string | null) => {
    const { x, y } = pressed ?? middleOf() ?? { x: 0, y: 0 };
    wash(x, y, picture);
  };
  if (!document.startViewTransition) {
    // no picture of the old screen to wash over: the chats show from the button, and everything gets its push
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
    // the mask's and the old picture's animations hold their last frame: they go with the pictures
    for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition")) a.cancel();
  });
}

const PUSHED = "[data-appbar] > *, [data-chat-panel] li, [data-chat-panel] header > *, #root :is(section, article, li, h1, h2, img, video, [data-tile])";

/**
 * The front from (x, y) and the pushes behind it. `picture`: the pseudo-element that holds the new screen, shown
 * through a round mask that grows (index.css gives it the mask; its size and place are animated here); null where there
 * is no such picture, and the chats alone are shown from the button. A ring of light rides on the front.
 */
function wash(x: number, y: number, picture: string | null): void {
  const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  // the front is the middle of the rim; it ends half a rim past the window's far corner, which is then all new
  const reach = far + RIM / 2;
  const STEPS = 30;
  const at = Array.from({ length: STEPS + 1 }, (_, i) => reach * frontAt(i / STEPS));
  const root = document.documentElement;
  if (picture) {
    const frames = at.map((f) => {
      const s = `${2 * f + RIM}px`;
      const p = `${x - f - RIM / 2}px ${y - f - RIM / 2}px`;
      return { maskSize: `${s} ${s}`, maskPosition: p, webkitMaskSize: `${s} ${s}`, webkitMaskPosition: p };
    });
    root.animate(frames, { duration: WASH, pseudoElement: picture, fill: "both" });
    // the old screen gives a little as the front leaves the button
    const origin = `${x}px ${y}px`;
    root.animate(
      [
        { transform: "scale(1)", transformOrigin: origin },
        { transform: "scale(1.012)", transformOrigin: origin },
      ],
      { duration: WASH, pseudoElement: "::view-transition-old(root)", fill: "both", easing: "ease-out" },
    );
  } else {
    const panel = document.querySelector<HTMLElement>("[data-chat-panel]");
    const px = x - (panel?.getBoundingClientRect().left ?? 0);
    panel?.animate?.(
      at.map((f) => ({ clipPath: `circle(${f}px at ${px}px ${y}px)` })),
      { duration: WASH },
    );
  }
  // the light on the front: a ring (index.css .chat-wash-front) whose brightest part stands at the front, fading as it spreads
  const ring = document.body.appendChild(document.createElement("div"));
  ring.className = "chat-wash-front";
  const BASE = 400;
  Object.assign(ring.style, { left: `${x - BASE / 2}px`, top: `${y - BASE / 2}px`, width: `${BASE}px`, height: `${BASE}px` });
  ring.animate(
    // the ring is brightest at 0.86 of its radius
    at.map((f, i) => ({ transform: `scale(${f / 0.86 / (BASE / 2)})`, opacity: Math.min(1, 2.4 * (1 - i / STEPS)) })),
    { duration: WASH, fill: "both" },
  ).finished.then(
    () => ring.remove(),
    () => ring.remove(),
  );
  const els = [...document.querySelectorAll<HTMLElement>(PUSHED)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 8 && r.height > 8 && r.width * r.height < innerWidth * innerHeight * 0.4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)
    .slice(0, 160);
  for (const { el, r } of els) {
    const dx = r.left + r.width / 2 - x;
    const dy = r.top + r.height / 2 - y;
    const d = Math.hypot(dx, dy) || 1;
    const k = PUSH * (1 - 0.5 * Math.min(1, d / far));
    const ux = (dx / d) * k;
    const uy = (dy / d) * k;
    const pushed = { transform: `translate(${ux}px, ${uy}px)` };
    const back = { transform: `translate(${-ux * 0.2}px, ${-uy * 0.2}px)` };
    const rest = { transform: "translate(0, 0)" };
    el.animate(
      // under the new screen's mask a thing is at its furthest as the front shows it, then settles; with no mask it
      // is in plain sight all along, so it starts from where it stands
      picture ? [pushed, { ...back, offset: 0.55 }, rest] : [rest, { ...pushed, offset: 0.3 }, { ...back, offset: 0.65 }, rest],
      // added to whatever transform the element has of its own (a centred dialog, a hover lift), never replacing it
      { duration: SETTLE, delay: WASH * frontReaches(d / reach), easing: "cubic-bezier(.3,.7,.3,1)", composite: "add", fill: "backwards" },
    );
  }
}
