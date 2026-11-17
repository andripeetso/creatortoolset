import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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
      <span className={cn("absolute rounded-full bg-violet-400/0 transition-colors group-hover:bg-violet-400/60 group-active:bg-violet-400",
        dir === "x" ? "inset-y-2 left-[1px] w-[2px]" : "inset-x-2 top-[1px] h-[2px]")} />
    </div>
  );
}

/** The four panels in their places. `media` null: no Media panel (the viewer takes its room). */
export function NleLayout({ media, viewer, inspector, timeline }: { media: ReactNode | null; viewer: ReactNode; inspector: ReactNode; timeline: ReactNode }) {
  const [sizes, setSizes] = useState(readSizes);
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
  const height = () => box.current?.clientHeight || 1;
  return (
    <div ref={box} data-nle className="dark flex min-h-0 w-full flex-1 flex-col bg-[#0f0f11] p-1 text-zinc-200 [color-scheme:dark]">
      <div className="flex min-h-0 shrink-0" style={{ height: `${sizes.top * 100}%` }}>
        {media !== null && (
          <>
            <div className="flex min-w-0 shrink-0" style={{ width: sizes.media }}>{media}</div>
            <div className="flex" onPointerDownCapture={begin}>
              <Splitter dir="x" label="Media width" onDrag={(d) => set({ media: from.current.media + d })} onDone={done} />
            </div>
          </>
        )}
        <div className="flex min-w-0 flex-1">{viewer}</div>
        <div className="flex" onPointerDownCapture={begin}>
          <Splitter dir="x" label="Inspector width" onDrag={(d) => set({ inspector: from.current.inspector - d })} onDone={done} />
        </div>
        <div className="flex min-w-0 shrink-0" style={{ width: sizes.inspector }}>{inspector}</div>
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
