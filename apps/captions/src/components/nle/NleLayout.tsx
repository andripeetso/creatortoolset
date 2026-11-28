import { createContext, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Images, PanelsTopLeft, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What the server's renders don't draw, for greying controls (lib/nle/check.ts NOT_RENDERED, or null where they work):
 * `v2` the controls that only make version-2 fields; `field(tracks, f)` a clip or track field on those tracks (f "" the
 * tracks themselves).
 */
export interface Gate { v2: string | null; field: (tracks: string[], f: string) => string | null }
export const NleGate = createContext<Gate>({ v2: null, field: () => null });

// The editor's panels, as a non-linear editor lays them out: Media, Viewer and Inspector side by side on top, the
// Timeline across the bottom taking the rest of the height. Each panel has its own title bar; the splitters between
// them set their sizes, which this browser keeps. The surface is dark in both app themes (the `dark` class gives the
// app's own tokens their dark values inside it), as editing tools are: a picture is judged against a dark surround.

const KEY = "ct-nle-layout";
type Sizes = { media: number; inspector: number; top: number };
const START: Sizes = { media: 260, inspector: 340, top: 0.5 };
// Beside the chats (chat mode) the editor keeps its own sizes and open panels: the viewer takes the room, the panels
// start hidden, and what is changed there never changes the editor outside chat mode
const CHAT_KEY = "ct-nle-layout-chat";
const CHAT_START: Sizes = { ...START, top: 0.66 };
const LIMIT = { media: [180, 520], inspector: [240, 520], top: [0.22, 0.8] } as const;
const clamp = (k: keyof Sizes, v: number) => Math.min(LIMIT[k][1], Math.max(LIMIT[k][0], v));

const readSizes = (chat: boolean): Sizes => {
  try {
    const got = JSON.parse(localStorage.getItem(chat ? CHAT_KEY : KEY) ?? "null") as Partial<Sizes> | null;
    const out = { ...(chat ? CHAT_START : START) };
    for (const k of Object.keys(START) as (keyof Sizes)[]) if (typeof got?.[k] === "number") out[k] = clamp(k, got[k]!);
    return out;
  } catch {
    return chat ? CHAT_START : START;
  }
};
const keepSizes = (s: Sizes, chat: boolean) => {
  try {
    localStorage.setItem(chat ? CHAT_KEY : KEY, JSON.stringify(s));
  } catch {
    // not kept: the sizes go back to the start ones next time
  }
};

// Which side panels are open (the window buttons on top, Tab and ⇧Tab), kept apart from the sizes.
const OPEN_KEY = "ct-nle-panels";
const CHAT_OPEN_KEY = "ct-nle-panels-chat";
const CHAT_MANUAL_OPEN_KEY = "ct-nle-panels-chat-manual";
type Open = { media: boolean; inspector: boolean };
const openKey = (chat: boolean, manual: boolean) => (!chat ? OPEN_KEY : manual ? CHAT_MANUAL_OPEN_KEY : CHAT_OPEN_KEY);
/** Open unless said otherwise; in chat mode hidden unless said otherwise, except a manual timeline (no `side`) which opens Media Pool. */
const readOpen = (chat: boolean, manual = false): Open => {
  try {
    const got = JSON.parse(localStorage.getItem(openKey(chat, manual)) ?? "null") as Partial<Open> | null;
    return chat
      ? { media: manual ? got?.media !== false : got?.media === true, inspector: got?.inspector === true }
      : { media: got?.media !== false, inspector: got?.inspector !== false };
  } catch {
    return { media: !chat || manual, inspector: !chat };
  }
};

// The page's side panel beside the viewer (chat mode, `side`): the viewer as a column as wide as its frame drawn as tall
// as the row lets it (a 9:16 cut leaves no grey bands), the panel the rest. The viewer's own bars and padding around
// the frame, and the least each needs.
const VIEWER_CHROME = 32 + 36 + 32 + 2;
const VIEWER_PAD = 32 + 2 + 2;
const VIEWER_MIN = 260;
/** narrower than this the viewer's bar keeps only the clock and the play buttons */
const VIEWER_NARROW = 420;
const SIDE_MIN = 260;

/** The viewer's width with the side panel beside it in a row of `room`, for a frame of `frame`; null: no room for the
 *  panel (a landscape cut keeps the width then). A portrait cut narrows its viewer to make room. */
export function viewerBeside(room: { w: number; h: number }, frame: { w: number; h: number }): number | null {
  const col = Math.max(VIEWER_MIN, Math.round(((room.h - VIEWER_CHROME) * frame.w) / frame.h) + VIEWER_PAD);
  if (room.w - col >= SIDE_MIN) return col;
  return frame.h > frame.w && room.w - VIEWER_MIN >= SIDE_MIN ? room.w - SIDE_MIN : null;
}

export const panelBar = "relative flex h-8 shrink-0 items-center gap-2 border-b border-black/60 bg-[#232327] px-2.5 text-[11px] text-zinc-400";

/** A framed panel: its title bar (the title, then whatever the panel puts beside it) and its body. */
export function Panel({ title, bar, children, className, label }: { title: string; bar?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? title} className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[5px] border border-black/70 bg-[#1b1b1e] shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]", className)}>
      <header className={panelBar}>
        <h2 className="shrink-0 font-semibold tracking-wide text-zinc-200">{title}</h2>
        {bar}
      </header>
      {children}
    </section>
  );
}

function Splitter({ dir, onDrag, onDone, label }: { dir: "x" | "y"; onDrag: (d: number) => void; onDone: () => void; label: string }) {
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const start = dir === "x" ? e.clientX : e.clientY;
    const moveIt = (ev: PointerEvent) => onDrag((dir === "x" ? ev.clientX : ev.clientY) - start);
    const upIt = () => {
      el.removeEventListener("pointermove", moveIt);
      el.removeEventListener("pointerup", upIt);
      el.removeEventListener("pointercancel", upIt);
      onDone();
    };
    el.addEventListener("pointermove", moveIt);
    el.addEventListener("pointerup", upIt);
    el.addEventListener("pointercancel", upIt);
  };
  return (
    <div role="separator" aria-orientation={dir === "x" ? "vertical" : "horizontal"} aria-label={label} onPointerDown={down}
      className={cn("group relative shrink-0 touch-none", dir === "x" ? "w-1 cursor-col-resize" : "h-1 w-full cursor-row-resize")}>
      <span className={cn("absolute rounded-full bg-violet-400/0 group-hover:bg-violet-400/60 group-active:bg-violet-400",
        dir === "x" ? "inset-y-2 left-[1px] w-[2px]" : "inset-x-2 top-[1px] h-[2px]")} />
    </div>
  );
}

/** A window button on the top bar: a panel's icon and name, bright while it is open. */
function WindowButton({ on, icon, label, keys, onClick }: { on: boolean; icon: ReactNode; label: string; keys: string; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={on} title={`${on ? "Hide" : "Show"} ${label} (${keys})`} onClick={onClick}
      className={cn("inline-flex h-full items-center gap-1.5 px-3 text-[12px] hover:bg-white/[0.04] [&_svg]:size-3.5", on ? "text-zinc-100" : "text-zinc-500")}>
      {icon}{label}
    </button>
  );
}

/**
 * The four panels in their places, under a thin bar of window buttons (Media Pool on the left, Inspector on the right)
 * that show and hide the side panels; a hidden one gives its room to the viewer. `media` null: no Media panel at all.
 * `panelKeys` gets what Tab (media) and ⇧Tab (inspector) call.
 *
 * `chat` (the page beside the chats): the page's own bar in place of the window buttons, with All editing tools at its
 * end showing both side panels or neither, and `foot` under the timeline. `timeline` given as a function hears whether
 * every tool shows (`full`: outside chat mode, or a side panel open), to draw a smaller one when not.
 */
export function NleLayout({ media, viewer, inspector, timeline, panelKeys, center, chat, side, frame }: {
  media: ReactNode | null; viewer: ReactNode; inspector: ReactNode; timeline: ReactNode | ((full: boolean) => ReactNode);
  /** the middle of the window-button bar, where Resolve has the project's name: the timeline's save */
  center?: ReactNode;
  panelKeys?: MutableRefObject<((p: keyof Open, on?: boolean) => void) | null>;
  chat?: { bar?: ReactNode; foot?: ReactNode } | null;
  /** beside the viewer while the side panels are hidden in chat mode (viewerBeside decides the room); `frame` its size */
  side?: ReactNode;
  frame?: { w: number; h: number };
}) {
  const inChat = !!chat;
  const manual = side === undefined;
  const [sizes, setSizes] = useState(() => readSizes(inChat));
  const [open, setOpen] = useState(() => readOpen(inChat, manual));
  // chat mode turned on or off with the editor open: that mode's own sizes and panels
  const mode = useRef(inChat);
  const manualRef = useRef(manual);
  useEffect(() => {
    if (mode.current === inChat && manualRef.current === manual) return;
    if (mode.current !== inChat) {
      mode.current = inChat;
      const s = readSizes(inChat);
      from.current = live.current = s;
      setSizes(s);
    }
    manualRef.current = manual;
    setOpen(readOpen(inChat, manual));
  }, [inChat, manual]);
  const keepOpen = (next: Open) => {
    try {
      localStorage.setItem(openKey(mode.current, manualRef.current), JSON.stringify(next));
    } catch {
      // not kept: the panels open as they were next time
    }
    return next;
  };
  const toggle = (p: keyof Open, on?: boolean) => setOpen((o) => keepOpen({ ...o, [p]: on ?? !o[p] }));
  const full = !inChat || open.inspector || (media !== null && open.media);
  const row = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const besideW = side && !full && frame ? viewerBeside(room, frame) : null;
  const allTools = () => setOpen(() => keepOpen({ media: !full, inspector: !full }));
  if (panelKeys) panelKeys.current = toggle;
  const box = useRef<HTMLDivElement>(null);
  const from = useRef(sizes);
  const live = useRef(sizes);
  const set = (patch: Partial<Sizes>) => {
    const next = { ...from.current };
    for (const k of Object.keys(patch) as (keyof Sizes)[]) next[k] = clamp(k, patch[k]!);
    live.current = next;
    setSizes(next);
  };
  const begin = () => void (from.current = live.current);
  const done = () => keepSizes(live.current, mode.current);
  const barH = inChat ? 40 : 28;
  const height = () => Math.max(1, (box.current?.clientHeight ?? 0) - barH); // less the bar of window buttons
  // hidden, not taken away: a panel shown again is as it was (the bin's search, the inspector's tab)
  const showMedia = media !== null && open.media;
  const chatBtn = (on: boolean) =>
    cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] [&_svg]:size-3.5",
      on ? "border-zinc-500 bg-zinc-700 text-zinc-50" : "border-zinc-700 text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100");
  return (
    <div ref={box} data-nle className="dark flex min-h-0 w-full flex-1 select-none flex-col bg-[#0f0f11] p-1 pt-0 text-zinc-200 [color-scheme:dark] [&_input]:select-text [&_textarea]:select-text">
      {chat ? (
        <div role="toolbar" aria-label="Editor" className="flex h-10 shrink-0 items-center gap-2 px-1">
          <div className="flex min-w-0 flex-1 items-center gap-2">{chat.bar}</div>
          <div className="flex shrink-0 items-center gap-2 text-[12px]">{center}</div>
          <div className="flex shrink-0 items-center gap-1">
            {media !== null && (
              <button type="button" aria-pressed={open.media} onClick={() => toggle("media")}
                title={`${open.media ? "Hide" : "Show"} Media Pool (Tab)`} className={chatBtn(open.media)}>
                <Images />Media Pool
              </button>
            )}
            <button type="button" aria-pressed={open.inspector} onClick={() => toggle("inspector")}
              title={`${open.inspector ? "Hide" : "Show"} Inspector (⇧Tab)`} className={chatBtn(open.inspector)}>
              <SlidersHorizontal />Inspector
            </button>
            <button type="button" aria-pressed={full} onClick={allTools}
              title={full ? "Hide the Media Pool, the Inspector and the empty tracks" : "The Media Pool, the Inspector and every track (Tab, ⇧Tab)"}
              className={cn(chatBtn(full), "px-2.5")}>
              <PanelsTopLeft />All editing tools
            </button>
          </div>
        </div>
      ) : (
        <div role="toolbar" aria-label="Panels" className="flex h-7 shrink-0 items-stretch justify-between">
          {media !== null ? <WindowButton on={open.media} icon={<Images />} label="Media Pool" keys="Tab" onClick={() => toggle("media")} /> : <span />}
          <div className="flex min-w-0 items-center gap-2 text-[12px]">{center}</div>
          <WindowButton on={open.inspector} icon={<SlidersHorizontal />} label="Inspector" keys="⇧Tab" onClick={() => toggle("inspector")} />
        </div>
      )}
      <div ref={row} className="flex min-h-0 shrink-0" style={{ height: `calc(${sizes.top * 100}% - ${sizes.top * barH}px)` }}>
        {media !== null && (
          <>
            <div className={cn("flex min-w-0 shrink-0", !showMedia && "hidden")} style={{ width: sizes.media }}>{media}</div>
            <div className={cn("flex", !showMedia && "hidden")} onPointerDownCapture={begin}>
              <Splitter dir="x" label="Media width" onDrag={(d) => set({ media: from.current.media + d })} onDone={done} />
            </div>
          </>
        )}
        <div data-narrow={besideW !== null && besideW < VIEWER_NARROW ? "" : undefined} className={cn("flex min-w-0", besideW === null ? "flex-1" : "shrink-0")} style={besideW === null ? undefined : { width: besideW }}>{viewer}</div>
        {besideW !== null && <div className="ml-1 flex min-w-0 flex-1">{side}</div>}
        <div className={cn("flex", !open.inspector && "hidden")} onPointerDownCapture={begin}>
          <Splitter dir="x" label="Inspector width" onDrag={(d) => set({ inspector: from.current.inspector - d })} onDone={done} />
        </div>
        <div className={cn("flex min-w-0 shrink-0", !open.inspector && "hidden")} style={{ width: sizes.inspector }}>{inspector}</div>
      </div>
      <div className="flex" onPointerDownCapture={begin}>
        <Splitter dir="y" label="Timeline height" onDrag={(d) => set({ top: from.current.top + d / height() })} onDone={done} />
      </div>
      <div className="flex min-h-0 flex-1">{typeof timeline === "function" ? timeline(full) : timeline}</div>
      {chat?.foot}
    </div>
  );
}

/** The panels with nothing in them yet, in the places the editor will have them (a timeline still loading). */
export function NleLoading({ media = true }: { media?: boolean }) {
  const empty = <div className="flex-1" />;
  return (
    <NleLayout media={media ? <Panel title="Media" className="flex-1">{empty}</Panel> : null}
      viewer={<Panel title="Viewer" className="flex-1"><div className="flex-1 bg-[#26262a]" /></Panel>}
      inspector={<Panel title="Inspector" className="flex-1">{empty}</Panel>}
      timeline={<Panel title="Timeline" className="flex-1">{empty}</Panel>} />
  );
}
