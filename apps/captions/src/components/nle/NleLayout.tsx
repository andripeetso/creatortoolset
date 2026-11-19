import { useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Images, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

// The editor's panels, as a non-linear editor lays them out: Media, Viewer and Inspector side by side on top, the
// Timeline across the bottom taking the rest of the height. Each panel has its own title bar; the splitters between
// them set their sizes, which this browser keeps. The surface is dark in both app themes (the `dark` class gives the
// app's own tokens their dark values inside it), as editing tools are: a picture is judged against a dark surround.

const KEY = "ct-nle-layout";
type Sizes = { media: number; inspector: number; top: number };
const START: Sizes = { media: 260, inspector: 300, top: 0.5 };
const LIMIT = { media: [180, 520], inspector: [240, 520], top: [0.22, 0.8] } as const;
const clamp = (k: keyof Sizes, v: number) => Math.min(LIMIT[k][1], Math.max(LIMIT[k][0], v));

const readSizes = (): Sizes => {
  try {
    const got = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Sizes> | null;
    const out = { ...START };
    for (const k of Object.keys(START) as (keyof Sizes)[]) if (typeof got?.[k] === "number") out[k] = clamp(k, got[k]!);
    return out;
  } catch {
    return START;
  }
};
const keepSizes = (s: Sizes) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not kept: the sizes go back to the start ones next time
  }
};

// Which side panels are open (the window buttons on top, Tab and ⇧Tab), kept apart from the sizes.
const OPEN_KEY = "ct-nle-panels";
type Open = { media: boolean; inspector: boolean };
const readOpen = (): Open => {
  try {
    const got = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null") as Partial<Open> | null;
    return { media: got?.media !== false, inspector: got?.inspector !== false };
  } catch {
    return { media: true, inspector: true };
  }
};

export const panelBar = "flex h-8 shrink-0 items-center gap-2 border-b border-black/60 bg-[#232327] px-2.5 text-[11px] text-zinc-400";

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
 */
export function NleLayout({ media, viewer, inspector, timeline, panelKeys }: {
  media: ReactNode | null; viewer: ReactNode; inspector: ReactNode; timeline: ReactNode;
  panelKeys?: MutableRefObject<((p: keyof Open) => void) | null>;
}) {
  const [sizes, setSizes] = useState(readSizes);
  const [open, setOpen] = useState(readOpen);
  const toggle = (p: keyof Open) => setOpen((o) => {
    const next = { ...o, [p]: !o[p] };
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      // not kept: the panels open as they were next time
    }
    return next;
  });
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
  const done = () => keepSizes(live.current);
  const height = () => Math.max(1, (box.current?.clientHeight ?? 0) - 28); // less the bar of window buttons
  // hidden, not taken away: a panel shown again is as it was (the bin's search, the inspector's tab)
  const showMedia = media !== null && open.media;
  return (
    <div ref={box} data-nle className="dark flex min-h-0 w-full flex-1 flex-col bg-[#0f0f11] p-1 pt-0 text-zinc-200 [color-scheme:dark]">
      <div role="toolbar" aria-label="Panels" className="flex h-7 shrink-0 items-stretch justify-between">
        {media !== null ? <WindowButton on={open.media} icon={<Images />} label="Media Pool" keys="Tab" onClick={() => toggle("media")} /> : <span />}
        <WindowButton on={open.inspector} icon={<SlidersHorizontal />} label="Inspector" keys="⇧Tab" onClick={() => toggle("inspector")} />
      </div>
      <div className="flex min-h-0 shrink-0" style={{ height: `calc(${sizes.top * 100}% - ${sizes.top * 28}px)` }}>
        {media !== null && (
          <>
            <div className={cn("flex min-w-0 shrink-0", !showMedia && "hidden")} style={{ width: sizes.media }}>{media}</div>
            <div className={cn("flex", !showMedia && "hidden")} onPointerDownCapture={begin}>
              <Splitter dir="x" label="Media width" onDrag={(d) => set({ media: from.current.media + d })} onDone={done} />
            </div>
          </>
        )}
        <div className="flex min-w-0 flex-1">{viewer}</div>
        <div className={cn("flex", !open.inspector && "hidden")} onPointerDownCapture={begin}>
          <Splitter dir="x" label="Inspector width" onDrag={(d) => set({ inspector: from.current.inspector - d })} onDone={done} />
        </div>
        <div className={cn("flex min-w-0 shrink-0", !open.inspector && "hidden")} style={{ width: sizes.inspector }}>{inspector}</div>
      </div>
      <div className="flex" onPointerDownCapture={begin}>
        <Splitter dir="y" label="Timeline height" onDrag={(d) => set({ top: from.current.top + d / height() })} onDone={done} />
      </div>
      <div className="flex min-h-0 flex-1">{timeline}</div>
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
