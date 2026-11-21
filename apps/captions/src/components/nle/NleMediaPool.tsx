import { useContext, useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { AlertTriangle, ArrowDownUp, ChevronDown, ChevronRight, ChevronUp, Film, Folder, LayoutGrid, List, Music, PanelLeft, Search, X } from "lucide-react";
import { isVideo, timecode, type NleTimeline } from "@/lib/nle/model";
import { thumbAt } from "@/lib/nle/thumbs";
import { cn } from "@/lib/utils";
import type { NleFile } from "./NlePlayer";
import { NleGate, Panel } from "./NleLayout";

// The Media Pool, laid out as Resolve's: a Bins column (Master, and under it the timeline's own sources and the page's
// library), and the open bin's clips as picture cards or as a list with columns. A click opens a clip in the viewer as
// the source; a clip with no file here is red (Media Offline); a right-click offers Relink… when the page can look for files.

/** A drag of one of the timeline's own sources (Media Pool → In this timeline): its key. */
export const SOURCE_MIME = "application/x-ct-nle-source";

/** One source of the timeline as the pool lists it. */
export interface PoolRow {
  src: string;
  name: string;
  path?: string;
  /** length in its own frames (unknown: a still, or a file whose length is not known) */
  frames?: number;
  fps: number;
  w?: number;
  h?: number;
  uses: number;
  /** used on a video track */
  video: boolean;
  /** every use is a designed flash, which the viewer draws: it never needs its file */
  flash: boolean;
}

export type SortKey = "name" | "dur" | "res" | "fps" | "uses";
export interface Sort { key: SortKey; up: boolean }

/** The sources the timeline's clips play, each with how often it is used. */
export function poolRows(tl: NleTimeline, nameOf: (src: string) => string): PoolRow[] {
  const by = new Map<string, PoolRow>();
  for (const [id, t] of Object.entries(tl.tracks)) for (const i of t.items) {
    let r = by.get(i.src);
    if (!r) {
      const s = tl.sources[i.src] ?? {};
      r = { src: i.src, name: nameOf(i.src), path: s.path, frames: s.dur, fps: s.fps || tl.timeline.fps, w: s.w, h: s.h, uses: 0, video: false, flash: true };
      by.set(i.src, r);
    }
    r.uses++;
    r.video ||= isVideo(id);
    r.flash &&= i.fx === "flash";
  }
  return [...by.values()];
}

const valueOf: Record<SortKey, (r: PoolRow) => number | string> = {
  name: (r) => r.name.toLowerCase(),
  dur: (r) => (r.frames ? r.frames / r.fps : -1),
  res: (r) => (r.w && r.h ? r.w * r.h : -1),
  fps: (r) => r.fps,
  uses: (r) => r.uses,
};

/** Rows in the order of one column, then by name. */
export function sortRows(rows: PoolRow[], { key, up }: Sort): PoolRow[] {
  const v = valueOf[key];
  return [...rows].sort((a, b) => {
    const x = v(a), y = v(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return (up ? c : -c) || a.name.localeCompare(b.name);
  });
}

const COLUMNS: [SortKey, string][] = [["name", "Clip Name"], ["dur", "Duration"], ["res", "Resolution"], ["fps", "Frame rate"], ["uses", "Uses"]];
export const STILL = /\.(png|jpe?g|webp|gif)$/i;
export const SOUND = /\.(wav|aif|aiff|m4a|mp3|flac|caf|aac)$/i;

type Bin = "master" | "timeline" | "library";
interface Prefs { view: "thumb" | "list"; size: number; sort: Sort; bins: boolean; master: boolean }
const PREFS = "ct.nle.mediaPool";
const DEFAULTS: Prefs = { view: "thumb", size: 96, sort: { key: "name", up: true }, bins: true, master: true };
const loadPrefs = (): Prefs => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
};

export function NleMediaPool({ tl, nameOf, here, bin, reveal, onPick, onOpen, onDrag, onBinDrag, onRelink, onNewText }: {
  tl: NleTimeline;
  nameOf: (src: string) => string;
  /** a source's file here (null: not here) */
  here: (src: string) => NleFile | null;
  /** the page's library, shown as its own bin */
  bin?: ReactNode;
  /** Find in Media Pool: this source shown picked and scrolled to (a new `n` asks again) */
  reveal?: { src: string; n: number } | null;
  /** selects the source's clips on the timeline */
  onPick: (src: string) => void;
  /** a click: the source in the viewer */
  onOpen: (src: string) => void;
  /** a source's drag starting (its key) and ending (null) */
  onDrag: (src: string | null) => void;
  /** a drag out of the library bin starting (its data, readable now only) and ending (null) */
  onBinDrag: (dt: DataTransfer | null) => void;
  /** looks for the files not found here */
  onRelink?: () => void;
  /** New Text, in its menu */
  onNewText?: () => void;
}) {
  const gate = useContext(NleGate);
  const [prefs, setPrefs] = useState(loadPrefs);
  const set = (p: Partial<Prefs>) => setPrefs((was) => {
    const now = { ...was, ...p };
    try { localStorage.setItem(PREFS, JSON.stringify(now)); } catch { /* kept for this page only */ }
    return now;
  });
  const [open, setOpen] = useState<Bin>("timeline");
  const [find, setFind] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; src: string } | null>(null);
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number; what: "view" | "sort" } | null>(null);
  const showBin = open === "library" && !bin ? "timeline" : open;

  const all = poolRows(tl, nameOf);
  const q = find?.trim().toLowerCase();
  const rows = sortRows(q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all, prefs.sort);
  // as the timeline marks a clip: no file here, or one the computer said won't play (a flash needs none)
  const offline = (r: PoolRow) => { const f = here(r.src); return !!r.path && !r.flash && (!f || !!f.why); };
  const bins: [Bin, string, number | null][] = [["timeline", "In this timeline", all.length], ...(bin ? [["library", "Library", null] as [Bin, string, null]] : [])];
  const title = showBin === "master" ? "Master" : bins.find((b) => b[0] === showBin)![1];

  const tool = "inline-flex h-6 shrink-0 items-center gap-0.5 rounded px-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100";
  const at = (e: MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(r.left, window.innerWidth - 200), y: r.bottom + 2 };
  };
  const sortBy = (key: SortKey) => set({ sort: { key, up: prefs.sort.key === key ? !prefs.sort.up : true } });
  const clip = (r: PoolRow) => ({
    draggable: !!r.path,
    title: String(r.path ?? r.src),
    "data-pool-src": r.src,
    onDragStart: (e: DragEvent) => { e.dataTransfer.setData(SOURCE_MIME, r.src); e.dataTransfer.effectAllowed = "copy"; onDrag(r.src); },
    onDragEnd: () => onDrag(null),
    onClick: () => { setPicked(r.src); onOpen(r.src); },
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); setPicked(r.src); setMenu({ x: e.clientX, y: e.clientY, src: r.src }); },
  });
  const pool = showBin !== "library";
  useEffect(() => {
    if (!reveal) return;
    setOpen("timeline");
    setFind(null);
    setPicked(reveal.src);
    // once the bin shows it
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>("[data-pool-src]")].find((el) => el.dataset.poolSrc === reveal.src)?.scrollIntoView?.({ block: "nearest" }));
  }, [reveal]);

  return (
    <Panel title="Media Pool" className="flex-1 select-none [&_input]:select-text"
      bar={
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <button type="button" className={cn(tool, prefs.bins && "text-zinc-100")} title="Bins" aria-pressed={prefs.bins} onClick={() => set({ bins: !prefs.bins })}>
            <PanelLeft className="size-3.5" />
          </button>
          {/* the open bin's name, when the bin list doesn't already show it lit */}
          <span className="min-w-0 flex-1 truncate pl-1 text-zinc-300">{!prefs.bins || (!prefs.master && showBin !== "master") ? title : ""}</span>
          {pool && (
            <>
              <button type="button" className={tool} title={prefs.view === "thumb" ? "Thumbnail View" : "List View"} aria-haspopup="menu"
                onClick={(e) => setViewMenu({ ...at(e), what: "view" })}>
                {prefs.view === "thumb" ? <LayoutGrid className="size-3.5" /> : <List className="size-3.5" />}
                <ChevronDown className="size-3" />
              </button>
              <button type="button" className={cn(tool, find !== null && "text-zinc-100")} title="Search" aria-pressed={find !== null} onClick={() => setFind(find === null ? "" : null)}>
                <Search className="size-3.5" />
              </button>
              <button type="button" className={tool} title="Sort" aria-haspopup="menu" onClick={(e) => setViewMenu({ ...at(e), what: "sort" })}>
                <ArrowDownUp className="size-3.5" />
              </button>
            </>
          )}
        </div>
      }>
      <div className="flex min-h-0 flex-1">
        {prefs.bins && (
          <nav aria-label="Bins" className="flex w-[112px] shrink-0 flex-col overflow-y-auto border-r border-black/60 bg-[#19191c] py-1 text-[12px]">
            <div className={cn("flex h-6 items-center text-zinc-300", showBin === "master" && "bg-zinc-800 text-zinc-50")}>
              <button type="button" aria-label={prefs.master ? "Collapse Master" : "Expand Master"} aria-expanded={prefs.master} className="flex h-6 w-5 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"
                onClick={() => set({ master: !prefs.master })}>
                {prefs.master ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              </button>
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setOpen("master")}>Master</button>
            </div>
            {prefs.master && bins.map(([b, name, n]) => (
              <button key={b} type="button" onClick={() => setOpen(b)} aria-current={showBin === b}
                className={cn("flex h-6 w-full min-w-0 items-center gap-1 pr-1.5 pl-6 text-left text-zinc-400 hover:bg-white/[0.04]", showBin === b && "bg-zinc-800 text-zinc-50 hover:bg-zinc-800")}>
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {n !== null && <span className="shrink-0 tabular-nums text-[10px] text-zinc-500">{n}</span>}
              </button>
            ))}
          </nav>
        )}
        {/* a right-click off the clips: the pool's own menu */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col"
          onContextMenu={(e) => { if (e.defaultPrevented || !onNewText || !pool) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, src: "" }); }}>
          {pool && find !== null && (
            <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-black/60 px-2">
              <Search className="size-3 shrink-0 text-zinc-500" />
              <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search" aria-label="Search clips"
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setFind(null); }}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600" />
              <button type="button" aria-label="Close search" className="text-zinc-500 hover:text-zinc-200" onClick={() => setFind(null)}><X className="size-3" /></button>
            </div>
          )}
          {showBin === "library" ? (
            <div className="flex min-h-0 flex-1 flex-col p-2" onDragStart={(e) => onBinDrag(e.dataTransfer)} onDragEnd={() => onBinDrag(null)}>{bin}</div>
          ) : showBin === "master" ? (
            <Folders view={prefs.view} size={prefs.size} bins={bins} onOpen={setOpen} />
          ) : prefs.view === "thumb" ? (
            <div role="group" aria-label="Clips" className="grid min-h-0 flex-1 content-start gap-x-2 gap-y-2.5 overflow-y-auto p-2"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${prefs.size}px, 1fr))` }}>
              {rows.map((r) => (
                <button key={r.src} type="button" {...clip(r)} className="group flex min-w-0 flex-col items-center gap-1 text-left">
                  <Card row={r} file={offline(r) ? null : here(r.src)} offline={offline(r)} picked={picked === r.src} />
                  <span className={cn("w-full truncate text-center text-[11px]", offline(r) ? "text-red-300" : "text-zinc-300")}>{r.name}</span>
                </button>
              ))}
              {!rows.length && <p className="col-span-full px-1 py-2 text-[12px] text-zinc-500">{q ? "No clips match" : "Empty"}</p>}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[420px] border-collapse text-[11px]">
                <thead className="sticky top-0 bg-[#1f1f23]">
                  <tr>
                    {COLUMNS.map(([key, label]) => (
                      <th key={key} scope="col" aria-sort={prefs.sort.key === key ? (prefs.sort.up ? "ascending" : "descending") : "none"} className="border-r border-b border-black/50 p-0 font-normal">
                        <button type="button" onClick={() => sortBy(key)} className="flex h-6 w-full items-center gap-1 px-1.5 text-left text-zinc-400 hover:text-zinc-100">
                          <span className="truncate">{label}</span>
                          {prefs.sort.key === key && (prefs.sort.up ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, n) => (
                    <tr key={r.src} {...clip(r)} className={cn("h-6 cursor-default text-zinc-300",
                      offline(r) ? "bg-red-950/70 text-red-200" : n % 2 ? "bg-white/[0.02]" : "",
                      picked === r.src && (offline(r) ? "bg-red-900/80" : "bg-zinc-700/70 text-zinc-50"))}>
                      <td className="max-w-[180px] truncate px-1.5">
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          {offline(r) ? <AlertTriangle className="size-3 shrink-0 text-red-400" /> : r.video ? <Film className="size-3 shrink-0 text-zinc-500" /> : <Music className="size-3 shrink-0 text-zinc-500" />}
                          <span className="truncate">{r.name}</span>
                        </span>
                      </td>
                      <td className="px-1.5 font-mono tabular-nums">{r.frames ? timecode(r.frames, r.fps) : ""}</td>
                      <td className="px-1.5 tabular-nums">{r.w && r.h ? `${r.w}×${r.h}` : ""}</td>
                      <td className="px-1.5 tabular-nums">{r.video ? r.fps : ""}</td>
                      <td className="px-1.5 tabular-nums">{r.uses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && <p className="px-2 py-2 text-[12px] text-zinc-500">{q ? "No clips match" : "Empty"}</p>}
            </div>
          )}
        </div>
      </div>
      {(menu || viewMenu) && (
        <div className="fixed inset-0 z-50" onPointerDown={() => { setMenu(null); setViewMenu(null); }} onContextMenu={(e) => { e.preventDefault(); setMenu(null); setViewMenu(null); }}>
          <div role="menu" className="fixed w-48 rounded-md border border-zinc-800 bg-zinc-950 py-1 text-[13px] text-zinc-200 shadow-xl"
            style={{ left: (menu ?? viewMenu)!.x, top: Math.min((menu ?? viewMenu)!.y, window.innerHeight - 200) }} onPointerDown={(e) => e.stopPropagation()}>
            {menu ? (
              <>
                {menu.src && <MenuRow label="Select on timeline" onClick={() => { onPick(menu.src); setMenu(null); }} />}
                {menu.src && onRelink && <MenuRow label="Relink…" onClick={() => { onRelink(); setMenu(null); }} />}
                {onNewText && <MenuRow label="New Text" off={gate.v2} onClick={() => { onNewText(); setMenu(null); }} />}
              </>
            ) : viewMenu!.what === "view" ? (
              <>
                <MenuRow label="Thumbnail View" on={prefs.view === "thumb"} onClick={() => { set({ view: "thumb" }); setViewMenu(null); }} />
                <MenuRow label="List View" on={prefs.view === "list"} onClick={() => { set({ view: "list" }); setViewMenu(null); }} />
                <div className="mx-3 my-1 border-t border-zinc-800" />
                <label className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-400">
                  Size
                  <input type="range" min={64} max={200} step={4} value={prefs.size} aria-label="Thumbnail size"
                    onChange={(e) => set({ size: Number(e.target.value) })} className="min-w-0 flex-1 accent-zinc-300" />
                </label>
              </>
            ) : (
              <>
                {COLUMNS.map(([key, label]) => (
                  <MenuRow key={key} label={label} on={prefs.sort.key === key} onClick={() => set({ sort: { key, up: prefs.sort.up } })} />
                ))}
                <div className="mx-3 my-1 border-t border-zinc-800" />
                <MenuRow label="Ascending" on={prefs.sort.up} onClick={() => set({ sort: { ...prefs.sort, up: true } })} />
                <MenuRow label="Descending" on={!prefs.sort.up} onClick={() => set({ sort: { ...prefs.sort, up: false } })} />
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function MenuRow({ label, on, off, onClick }: { label: string; on?: boolean; /** greyed, and why */ off?: string | null; onClick: () => void }) {
  return (
    <button type="button" role={on === undefined ? "menuitem" : "menuitemradio"} aria-checked={on} onClick={onClick} disabled={!!off} title={off ?? undefined}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent">
      <span className="w-3 shrink-0 text-zinc-300">{on ? "✓" : ""}</span>
      {label}
    </button>
  );
}

/** Master: its bins, as folders. */
function Folders({ view, size, bins, onOpen }: { view: Prefs["view"]; size: number; bins: [Bin, string, number | null][]; onOpen: (b: Bin) => void }) {
  if (view === "list") {
    return (
      <ul aria-label="Bins in Master" className="min-h-0 flex-1 overflow-y-auto text-[11px]">
        {bins.map(([b, name]) => (
          <li key={b}>
            <button type="button" onClick={() => onOpen(b)} className="flex h-6 w-full items-center gap-1.5 px-1.5 text-left text-zinc-300 hover:bg-white/[0.04]">
              <Folder className="size-3 shrink-0 text-zinc-500" /> {name}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}>
      {bins.map(([b, name]) => (
        <button key={b} type="button" onClick={() => onOpen(b)} className="flex min-w-0 flex-col items-center gap-1">
          <span className="flex aspect-video w-full items-center justify-center"><Folder className="size-3/5 fill-zinc-500 text-zinc-400" strokeWidth={1} /></span>
          <span className="w-full truncate text-center text-[11px] text-zinc-300">{name}</span>
        </button>
      ))}
    </div>
  );
}

/** A clip's picture card: its picture, a sound card for sound, or red Media Offline. */
function Card({ row, file, offline, picked }: { row: PoolRow; file: NleFile | null; offline: boolean; picked: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sound = !row.video || SOUND.test(row.path ?? "");
  const still = STILL.test(row.path ?? "");
  const url = file?.url ?? null;
  const lead = file?.lead ?? 0;
  useEffect(() => {
    if (!url || sound || still) return;
    let gone = false;
    const sec = Math.floor(lead + (row.frames ? Math.min(1, row.frames / row.fps / 2) : 0));
    void thumbAt(url, sec, 180).then((b) => {
      const c = canvas.current;
      if (gone || !b || !c) return;
      c.width = b.width;
      c.height = b.height;
      c.getContext("2d")?.drawImage(b, 0, 0);
    });
    return () => void (gone = true);
  }, [url, lead, sound, still, row.frames, row.fps]);
  return (
    <span className={cn("relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[3px] border",
      offline ? "border-red-900 bg-[#3b0b0b]" : sound ? "border-emerald-900/70 bg-emerald-950" : "border-black/60 bg-black",
      picked && "outline outline-2 outline-offset-1 outline-zinc-300")}>
      {offline ? (
        <span className="flex flex-col items-center gap-0.5 text-red-400">
          <AlertTriangle className="size-4" />
          <span className="text-[9px] font-medium">Media Offline</span>
        </span>
      ) : sound ? (
        <Music className="size-5 text-emerald-400/80" />
      ) : still && url ? (
        <img src={url} alt="" draggable={false} className="size-full object-contain" />
      ) : url ? (
        <canvas ref={canvas} className="size-full object-contain" />
      ) : (
        <Film className="size-5 text-zinc-600" />
      )}
      {!offline && !sound && <Film className="absolute bottom-0.5 left-1 size-3 text-white/70 drop-shadow" />}
    </span>
  );
}
