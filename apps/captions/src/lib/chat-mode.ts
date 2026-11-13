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
/** The list of chats beside the open chat: its width until its edge is dragged, and the least and most it can be given. */
export const LIST_W = 280;
export const LIST_MIN = 220;
export const LIST_MAX = 480;
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
  /** The list's width as dragged (its own edge); 0 = LIST_W. */
  lw: number;
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
    const px = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
    return { on: s?.on === true, w: px(s?.w), lw: px(s?.lw), page: s?.page !== false, bare: s?.bare === true };
  } catch {
    return { on: false, w: 0, lw: 0, page: true, bare: false };
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
      const next: Stored = { on: patch.on ?? s.on, w: patch.w ?? s.w, lw: patch.lw ?? s.lw, page: patch.page ?? s.page, bare: patch.bare ?? s.bare };
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
  /** The list's width there: as dragged, less where the open chat would get under its least. */
  listW: number;
}

/**
 * How the window `win` wide is shared. The page never gets less than MIN_PAGE nor the open chat less than MIN_CHAT;
 * `need` is what the screen on show asks for itself (usePageNeeds), given as far as the chat's least allows.
 */
export function chatLayout(s: Pick<Stored, "w" | "page"> & { bare?: boolean; lw?: number }, win: number, need = 0): ChatLayout {
  const forced = win - MIN_PAGE < MIN_CHAT;
  const full = !s.page || forced || !!s.bare;
  const room = win - Math.max(MIN_PAGE, Math.min(need, win - MIN_CHAT));
  // half the window until the edge is dragged
  const chat = full ? win : Math.min(Math.max(s.w || Math.round(win / 2), MIN_CHAT), room);
  // the list gives way to the open chat, down to its own least, before it folds away
  const listW = Math.min(Math.min(Math.max(s.lw || LIST_W, LIST_MIN), LIST_MAX), chat - MIN_CHAT);
  return { chat, full, forced, list: listW >= LIST_MIN, listW };
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
  const lw = useChatMode((s) => s.lw);
  const need = useChatMode((s) => s.need);
  const [win, setWin] = useState(pageWidth);
  useEffect(() => {
    const on = () => setWin(pageWidth());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const layout = chatLayout({ w, page, bare, lw }, win, need);
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

/** Turn chat mode on or off from its button (⌘J: the one on screen): the one switch that is shown with the wave. */
export function toggleChatMode(from?: HTMLElement | null): void {
  washTo({ on: !useChatMode.getState().on }, from, { wash: true });
}

/** How long the front takes to cross the window (ms). */
export const WASH = 780;
/** How wide the soft rim is where the two screens meet (px; index.css has the same number). */
const RIM = 140;
/** How far in from its rim the light's brightest line is (px; index.css has the same number). */
const LIGHT_RIM = 60;
/** The front's radius at the press (px): it comes out from around the button. */
const START = 22;
/** How far the front carries a thing along its way (px), and how far out of focus the thing is under it (px of blur).
 *  Everything moves the way the front goes: what leaves is carried off ahead of it, what comes is let go behind it. */
const CARRY = 22;
const SOFT = 4;
/** The largest thing that goes out of focus (px², its area): blurring a large one (a video, a long text) costs frames. */
const SOFT_MOST = 40_000;
/** How much larger a thing that leaves gets as it is carried off, and how small a thing that comes starts. A thing
 *  that comes is never larger than it will be nor further out than its place: either would make the box it scrolls in
 *  wider for that moment, and bars would come and go. */
const SWELL = 1.06;
const SMALL = 0.92;
/** A thing has landed in its place by the time the front is this far past it (px): what is still out of place is
 *  always close behind the light, never a screenful that settles after the light has gone. One movement, slow to
 *  leave where the front held it and soft where it ends; nothing springs back. */
const PAST = 320;
/** The landing takes no longer than this (ms; near the button, where the front is slow) and no less (at the far side,
 *  where it is fast: quicker than this would be a jump). */
const LAND = 440;
const LAND_LEAST = 160;
/** How many things of the screen that leaves are carried off one by one, nearest the button first. Each is a picture
 *  of its own for the browser, and with many more than this the press waits on them. */
const MOST_LEAVING = 30;
/** How long a thing of the screen that leaves may be along the front's way (px) and still be carried off by itself. */
const ACROSS = 220;
/** How many things of the new screen land one by one, nearest the button first. */
const MOST_LANDING = 140;
/** How far across its reach the front is (0 to 1) at `t` (0 to 1): on its way at once, slow at first, fast at the end. */
export const frontAt = (t: number): number => 0.14 * t + 0.86 * t ** 2.2;
/** When (0 to 1) the front is `d` of its reach from the button: frontAt the other way round. */
export function frontReaches(d: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (frontAt(mid) < d) lo = mid;
    else hi = mid;
  }
  return d <= 0 ? 0 : d >= 1 ? 1 : (lo + hi) / 2;
}

/** The switch on its way and what it changes. */
let washing: { skipTransition(): void } | null = null;
let washingTo: Partial<Stored> = {};
/** The new screen's things that are still landing, and the looks still to come for things it fills in late. */
let landing: Animation[] = [];
let looks: number[] = [];

/** A switch cut short by another one: its light goes at once and everything is in its place. */
function cutShort(): void {
  washing?.skipTransition();
  for (const a of landing) a.cancel();
  for (const id of looks) window.clearTimeout(id);
  landing = [];
  looks = [];
}

/** The middle of `el`, or of the chat-mode button on screen. */
function middleOf(el?: Element | null): { x: number; y: number } | null {
  const r = (el ?? [...document.querySelectorAll("[data-chat-toggle]")].find((b) => b.getBoundingClientRect().width))?.getBoundingClientRect();
  return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

/** What counts as one thing on a screen: what the front moves by itself. A thing inside another moves with it. Not a
 *  video or a canvas: a player sizes itself to its page a moment after the page has its new width, and stays put. */
const THINGS = "[data-appbar] > *, [data-chat-panel] header > *, :is(#root, [data-chat-panel]) :is(button, a[href], li, h1, h2, h3, p, img, textarea, input, [data-tile])";

interface Thing {
  el: HTMLElement;
  /** How far from the button its nearest point and its middle are (px). */
  near: number;
  mid: number;
  /** The way the front goes at it: away from the button. */
  ux: number;
  uy: number;
  /** How far out of focus it is under the front (px of blur). */
  soft: number;
}

/**
 * The things on screen now (or only those in `within`), nearest (x, y) first, `most` of them. `pictures`: for the
 * screen that leaves, where each thing becomes a picture of its own. Only those seen in full then (a picture is drawn
 * uncut: not what a scrolling box cuts, not what stands under a bar or a dialog), and only those the front crosses in
 * one go: a picture goes as one, and a long thing lying along the front's way would stay over the new screen until
 * the front had passed all of it.
 */
function things(x: number, y: number, most: number, pictures: boolean, within: ParentNode = document): Thing[] {
  const all: Array<Thing & { r: DOMRect }> = [];
  let last: Element | null = null;
  for (const el of within.querySelectorAll<HTMLElement>(THINGS)) {
    // in document order, so what is inside the thing before it comes right after it
    if (last?.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || r.width * r.height > innerWidth * innerHeight * 0.2) continue;
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    last = el;
    const near = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    if (pictures && Math.hypot(Math.max(x - r.left, r.right - x), Math.max(y - r.top, r.bottom - y)) - near > ACROSS) continue;
    const dx = r.left + r.width / 2 - x;
    const dy = r.top + r.height / 2 - y;
    const mid = Math.hypot(dx, dy) || 1;
    all.push({
      el,
      r,
      near,
      mid,
      ux: dx / mid,
      uy: dy / mid,
      soft: r.width * r.height > SOFT_MOST ? 0 : SOFT,
    });
  }
  all.sort((a, b) => a.near - b.near);
  if (!pictures) return all.slice(0, most);
  const seen = ({ el, r }: { el: HTMLElement; r: DOMRect }) =>
    [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [r.left + r.width / 2, r.top + r.height / 2]].every(([px, py]) => {
      const hit = document.elementFromPoint(px, py);
      return !!hit && (el.contains(hit) || hit.contains(el));
    });
  const out: Thing[] = [];
  for (const t of all) {
    if (seen(t)) out.push(t);
    if (out.length >= most) break;
  }
  return out;
}

/**
 * Change how chat mode shares the window (on or off, the page shown or hidden); `also` is what else changes in the
 * same breath (the chat on show). The change is there at once, with no effect, for everything but one switch.
 *
 * `wash`: chat mode itself turned on or off, from its button or ⌘J. Only then a wave goes out from the button across
 * the window, slow at first and fast at the end, and the screen changes under it. Ahead of its front the screen is as
 * it was; the front carries off each thing it reaches, out of focus and fading; behind it the new screen's things are
 * let go one by one, small and out of focus, and land in their places in one movement each. Everything moves the way
 * the front goes. One band of light rides the front and leaves the window with it. With no button (⌘J on a screen
 * whose bar has none) it starts where the button stands. Chat mode switched again while it runs, or where motion is
 * turned down, and the new screen is there at once. Anything else that changes meanwhile (the open chat's page comes
 * beside it, a new chat's page goes) changes under the wave, in the screen the front is showing: such a change
 * follows a switch within a moment, and ending the wave for it left the switch with no effect at all.
 *
 * In the Mac app the app draws the wave instead (macWash): the window's own picture bends at the front.
 *
 * The page shown or hidden beside the chats, a new chat, a chat's first page: those happen all day, and an effect on
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
  if (washing && !how.wash) return change();
  const mac = macWave();
  if (!how.wash || washing || (!mac && !document.startViewTransition) || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    cutShort();
    return change();
  }
  const root = document.documentElement;
  // no button on screen: about where it stands in the chats' bar
  const { x, y } = middleOf(from) ?? middleOf() ?? { x: 28, y: 28 };
  if (mac) return void macWash(mac, x, y, patch, change);
  // the front is the middle of the rim; it ends half a rim past the window's far corner, which is then all new
  const reach = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + RIM / 2;
  /** When (ms after the start) the front is `d` px from the button. */
  const at = (d: number) => WASH * frontReaches((d - START) / (reach - START));
  // the things that leave are named, so the browser keeps a picture of each and the front can move it by itself
  const leaving = things(x, y, MOST_LEAVING, true);
  leaving.forEach(({ el }, i) => el.style.setProperty("view-transition-name", `chat-wash-${i}`));
  // index.css: while this class is on, the pictures are not cross-faded and the new screen has its round mask
  root.classList.add("chat-wash");
  let light: HTMLElement | null = null;
  const t = document.startViewTransition(() => {
    try {
      // the screen has to be the new one by the time this returns (useChatModeLayout puts the layout on <html> in a
      // layout effect, so one synchronous render does it)
      flushSync(change);
    } finally {
      // a thing that is on the new screen too is no picture there: it is itself, and lands (wave)
      for (const { el } of leaving) el.style.removeProperty("view-transition-name");
      // the light is a picture of its own, the last one, so it is drawn over everything (index.css)
      light = document.body.appendChild(document.createElement("div"));
      light.className = "chat-wash-light";
    }
  });
  washing = t;
  washingTo = patch;
  t.ready.then(
    () => wave(x, y, reach, at, leaving),
    () => {},
  );
  void t.finished.finally(() => {
    washing = null;
    washingTo = {};
    root.classList.remove("chat-wash");
    light?.remove();
    // an animation of a picture holds its last frame: it goes with the pictures
    for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition")) a.cancel();
  });
}

/** The Mac app draws the wave itself (apps/mac ChatWave.swift): it bends the window's own picture, which a page cannot. */
interface MacWave {
  postMessage(m: unknown): Promise<unknown>;
}
const macWave = (): MacWave | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { chatWave?: MacWave } } }).webkit?.messageHandlers?.chatWave;

/**
 * The wave in the Mac app: a picture of the screen as it is goes up over the page, the page changes under it, and once
 * that is on screen the app takes a picture of the new screen and the front goes. Chat mode switched again meanwhile
 * (cutShort) ends it at once. No picture (an old app, no Metal): the page changes with no wave.
 */
async function macWash(mac: MacWave, x: number, y: number, patch: Partial<Stored>, change: () => void): Promise<void> {
  const root = document.documentElement;
  const run = { skipTransition: () => void mac.postMessage("stop").catch(() => {}) };
  washing = run;
  washingTo = patch;
  try {
    const up = await mac
      .postMessage({ start: { x, y, dark: root.classList.contains("dark"), tint: getComputedStyle(root).getPropertyValue("--violet-600").trim() } })
      .catch(() => false);
    flushSync(change);
    if (up !== true || washing !== run) return;
    // the new screen is drawn before its picture is taken
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await mac.postMessage("drawn").catch(() => {});
  } finally {
    if (washing === run) {
      washing = null;
      washingTo = {};
    }
  }
}

/**
 * The wave from (x, y): the new screen shows through a round mask that grows with the front (index.css gives it the
 * mask; its size and place are animated here), the light is drawn on the front, each thing that leaves is carried
 * off and fades as the front crosses it, and each thing of the new screen is held a little behind its place, small
 * and out of focus, and lands once the front has reached it.
 */
function wave(x: number, y: number, reach: number, at: (d: number) => number, leaving: Thing[]): void {
  const root = document.documentElement;
  const STEPS = 30;
  /** A round picture `r` px to its rim, centred on the button. */
  const round = (r: number) => ({ size: `${2 * r}px ${2 * r}px`, place: `${x - r}px ${y - r}px` });
  const fronts = Array.from({ length: STEPS + 1 }, (_, i) => START + (reach - START) * frontAt(i / STEPS));
  root.animate(
    fronts.map((f) => {
      const { size, place } = round(f + RIM / 2);
      return { maskSize: size, maskPosition: place, webkitMaskSize: size, webkitMaskPosition: place };
    }),
    { duration: WASH, pseudoElement: "::view-transition-new(root)", fill: "both" },
  );
  // the light's brightest line is LIGHT_RIM in from its rim (index.css), and that line is the front. It moves with the
  // mask in the same way (a size and a place), so the two cannot come apart
  root.animate(
    fronts.map((f, i) => {
      const { size, place } = round(f + LIGHT_RIM);
      // there from the first frame, so the press is answered at once
      return { backgroundSize: size, backgroundPosition: place, opacity: Math.min(1, 0.5 + i / 2) };
    }),
    { duration: WASH, pseudoElement: "::view-transition-group(chat-wash-light)", fill: "both" },
  );
  /** A thing `by` px along the front's way (behind its place when less than none) and `size` times its size. */
  const moved = ({ ux, uy }: Thing, by: number, size: number) => `translate(${(ux * by).toFixed(1)}px, ${(uy * by).toFixed(1)}px) scale(${size})`;
  leaving.forEach((thing, i) => {
    const { near, mid } = thing;
    // from when the rim first touches it until its middle is all new screen
    const end = at(mid + RIM / 2);
    const start = Math.max(0, Math.min(at(near - RIM / 2), end - 140));
    root.animate([{ transform: "none", filter: "blur(0px)", opacity: 1 }, { opacity: 1, offset: 0.4 }, { transform: moved(thing, CARRY, SWELL), filter: `blur(${thing.soft}px)`, opacity: 0 }], {
      duration: Math.max(140, end - start),
      delay: start,
      easing: "ease-in",
      pseudoElement: `::view-transition-old(chat-wash-${i})`,
      fill: "both",
    });
  });
  // Added to whatever transform and filter a thing has of its own (a hover lift, a dimmed picture), never in their
  // place. Each starts just before the rim shows the first of it and is over when it has landed: until then and after
  // that the thing is as the page made it, so nothing is held out of place or out of focus that is not being shown so
  const held = (thing: Thing) => ({ transform: moved(thing, -CARRY, SMALL), filter: `blur(${thing.soft}px)` });
  const began = performance.now();
  const taken = new Set<Element>();
  /** `within`: a later look, through the chats only. */
  const land = (within?: ParentNode) => {
    const now = within ? performance.now() - began : 0;
    for (const thing of things(x, y, MOST_LANDING, false, within)) {
      const { el, near } = thing;
      if (taken.has(el)) continue;
      taken.add(el);
      // what comes in by a movement of its own is left to it: two movements at once fight
      if (el.getAnimations().length) continue;
      const start = Math.max(0, at(near - RIM / 2) - 20);
      // found late and shown already: it stays as it is
      if (within && start <= now) continue;
      const wait = at(near) - start;
      const lands = Math.min(LAND, Math.max(LAND_LEAST, at(near + PAST) - at(near)));
      landing.push(
        el.animate(
          [held(thing), { ...held(thing), offset: wait / (wait + lands), easing: "cubic-bezier(.4,0,.2,1)" }, { transform: "translate(0px, 0px) scale(1)", filter: "blur(0px)" }],
          { duration: wait + lands, delay: start - now, composite: "add" },
        ),
      );
    }
  };
  landing = [];
  land();
  // what the chats fill in a moment later (their list is read as they open) is the front's as well, where the front
  // has not been yet. Only the chats are looked through again: a look through the whole of a big page costs a frame
  const chats = document.querySelector("[data-chat-panel]");
  looks = chats ? [80, 200, 400].map((ms) => window.setTimeout(() => land(chats), ms)) : [];
  // The pictures stay until the last things are all but in their places (they are all new screen by then): taking
  // them down costs the browser a long frame, and in the middle of the landing that showed as a jolt. No longer than
  // that: where the browser lets no click through them (index.css asks it to), the new screen cannot be used until then
  root.animate({ opacity: [1, 1] }, { duration: WASH + LAND_LEAST * 0.75, pseudoElement: "::view-transition-old(root)" });
}
