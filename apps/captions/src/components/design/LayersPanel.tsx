import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Circle, Contrast, Eye, EyeOff, Frame, Group, Image, Lock, LockOpen, PenTool, Plus, Spline, Square, SquaresExclude, SquaresIntersect, SquaresSubtract, SquaresUnite, Star, Triangle, Type } from "lucide-react";
import type { DesignPage, Layer } from "@contracts/design";
import { groupName, layerName, pageName } from "@/lib/design/hands";
import { isGroup, mapLayers, moveRow, parentOf, pathTo } from "@/lib/design/tree";
import { cn } from "@/lib/utils";
import { Tip } from "./Tip";

/**
 * The layers list: every frame of the canvas with its layers under it, the front one on top. A click picks (⌘ adds or
 * takes one; Shift picks every row from the last one clicked: the layers between, or the frames when the run goes past
 * a frame, never the layers a picked frame already holds), a double click on a name renames and one on its icon zooms
 * the canvas to it, the eye hides and the lock locks, and a row is dragged to a
 * new place: a layer among its frame's layers (in or out of a group or a frame-like container: let go on the middle of a
 * container's row, it goes into it), a frame among the frames. A container's layers lie under its row, which opens and
 * closes them. Layers of an older group (a shared name) lie under a Group row,
 * which picks them all; a layer's own row picks that layer alone (where two frames lie over each other, the
 * lower one in the list is drawn on top, and the list's order numbers the saved PNGs).
 */

const ROW = "group relative flex h-8 w-full cursor-default items-center gap-1.5 pr-2 text-left";
const ON = "bg-[#0d99ff]/20";
const KIND = { text: Type, image: Image, drawing: PenTool, path: Spline, group: Group } as const;
const SHAPE = { rect: Square, ellipse: Circle, triangle: Triangle, star: Star, arrow: ArrowRight } as const;
const BOOLEAN = { union: SquaresUnite, subtract: SquaresSubtract, intersect: SquaresIntersect, exclude: SquaresExclude } as const;

/** The layers of a list a mask under them cuts (up to the next mask; a hidden mask cuts nothing). None in a boolean group: its layers are its shape. */
export function maskedIn(list: readonly Layer[], combined = false): Set<string> {
  const out = new Set<string>();
  let on = false;
  for (const l of combined ? [] : list) {
    if (l.mask) on = !l.hidden;
    else if (on) out.add(l.id);
  }
  return out;
}

/** Where a dragged row goes: above or below row `key`, or (`into`) into the container it is the row of. */
type Drop = { key: string; after: boolean; into?: boolean };


export function LayersPanel({
  pages,
  at,
  selected,
  framed,
  framedIds,
  onPick,
  onPoint,
  onPage,
  onMovePage,
  onAddPage,
  onZoomTo,
}: {
  pages: DesignPage[];
  at: number;
  selected: string[];
  framed: boolean;
  /** every picked frame, by id */
  framedIds: readonly string[];
  onPick: (at: number, ids: string[], framed?: boolean, frames?: string[]) => void;
  /** the layer the pointer is on, for the canvas to outline */
  onPoint: (id: string | null) => void;
  /** a frame with a layer renamed, hidden, locked or moved (one step to undo) */
  onPage: (page: DesignPage) => void;
  onMovePage: (from: number, to: number) => void;
  onAddPage: () => void;
  /** the canvas zoomed to frame `at`, or to its layer `id` */
  onZoomTo: (at: number, id?: string) => void;
}) {
  const [shut, setShut] = useState<string[]>([]);
  // a layer picked on the canvas inside a closed container: its containers (and its frame) open, so its row shows
  const pickedIn = pages[at] && selected[0] ? (pathTo(pages[at]!.layers, selected[0]) ?? []).map((g) => `${pages[at]!.id}/${g.id}`) : [];
  const opening = [...pickedIn, ...(pickedIn.length || selected.length ? [pages[at]?.id ?? ""] : [])].join("|");
  useEffect(() => {
    const open = opening.split("|");
    setShut((s) => (s.some((x) => open.includes(x)) ? s.filter((x) => !open.includes(x)) : s));
  }, [opening]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const dropped = useRef(false);
  const dragging = useRef(false);
  /** The row a Shift-click runs from: the last one clicked without Shift (a frame's row: no layer). */
  const anchor = useRef<{ page: string; layer?: string } | null>(null);
  /** Shift-click on frame `k` (its layer `id`, or its own row): the run from the anchor. Within one frame's layers, those layers; past a frame, the frames. */
  const run = (k: number, id?: string): boolean => {
    const a = anchor.current;
    const from = a ? pages.findIndex((p) => p.id === a.page) : -1;
    if (!a || from < 0) return false;
    if (from === k && a.layer && id) {
      // the layers beside it, in its container
      const list = [...(parentOf(pages[k]!.layers, id)?.layers ?? pages[k]!.layers)].reverse().map((l) => l.id);
      const [lo, hi] = [list.indexOf(a.layer), list.indexOf(id)].sort((x, y) => x - y);
      if (lo! < 0) return false;
      onPick(k, list.slice(lo, hi! + 1));
      return true;
    }
    const ids = pages.slice(Math.min(from, k), Math.max(from, k) + 1).filter((p) => !p.loose).map((p) => p.id);
    if (!ids.length) return false;
    onPick(pages.findIndex((p) => p.id === ids[0]), [], true, ids);
    return true;
  };
  /** A double click on a row's icon: that row picked and the canvas zoomed to it (not a rename). */
  const zoomOn = (k: number, id?: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (id) onPick(k, [id]);
    else onPick(k, [], true);
    onZoomTo(k, id);
  };

  const rename = (was: string, done: (name: string) => void) => (
    <input
      autoFocus
      aria-label="Name"
      defaultValue={was}
      maxLength={60}
      onFocus={(e) => ((dropped.current = false), e.currentTarget.select())}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        // Escape leaves the name as it was
        if (e.key === "Escape") {
          dropped.current = true;
          setRenaming(null);
        }
      }}
      onBlur={(e) => {
        if (!dropped.current && e.currentTarget.value.trim() !== was) done(e.currentTarget.value.trim());
        dropped.current = false;
        setRenaming(null);
      }}
      className="h-6 min-w-0 flex-1 rounded-sm bg-white px-1 text-[11px] text-zinc-50 outline outline-1 outline-[#0d99ff] dark:bg-[#1e1e1e]"
    />
  );

  /**
   * A row dragged to a new place: once the pointer has moved, the row under it shows a line above or below, and the
   * row goes there when the pointer lifts. By the pointer's own events, not the browser's drag and drop: after one of
   * those, WebKit gives the next press no pointerdown, and the canvas would miss a click (found in a real browser).
   */
  const dragRow = (e: React.PointerEvent, fits: (key: string) => boolean, done: (to: Drop) => void) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let to: Drop | null = null;
    const move = (ev: PointerEvent) => {
      if (!dragging.current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      dragging.current = true;
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-row]");
      const key = row?.dataset.row;
      const r = row?.getBoundingClientRect();
      // the middle of a container's row: into it
      const inside = row?.dataset.container !== undefined && r && Math.abs(ev.clientY - r.top - r.height / 2) < r.height / 4;
      to = key && r && fits(key) ? { key, after: ev.clientY > r.top + r.height / 2, ...(inside ? { into: true } : {}) } : null;
      setDrop(to);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrop(null);
      // the click that ends a drag picks nothing: the flag is down again once that click has passed
      setTimeout(() => (dragging.current = false), 0);
      if (to) done(to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const line = (key: string) => drop?.key === key && (drop.into ? <span className="pointer-events-none absolute inset-0 rounded-sm border-2 border-[#0d99ff]" /> : <span className={cn("pointer-events-none absolute inset-x-2 h-0.5 bg-[#0d99ff]", drop.after ? "bottom-0" : "top-0")} />);

  /** The rows of `list` (layers of frame `k`, or of a container in it), front first, each container's own under it. */
  const rows = (p: DesignPage, k: number, list: readonly Layer[], depth: number, combined = false) => {
    const layerKey = `l:${p.id}:`;
    const shown = [...list].reverse();
    const cut = maskedIn(list, combined);
    return shown.map((l, n) => {
      const key = layerKey + l.id;
      // the first of a run of one older group's layers (a shared name) gets the group's own row above it
      // (a group that is down to one layer is a single layer again)
      const members = l.group ? list.filter((x) => x.group === l.group).map((x) => x.id) : [];
      const grouped = members.length > 1;
      const heads = grouped && shown[n - 1]?.group !== l.group;
      const allOn = k === at && members.length > 0 && members.every((id) => selected.includes(id));
      const on = k === at && selected.includes(l.id);
      const Icon = l.mask && !combined ? Contrast : l.type === "shape" ? SHAPE[l.shape] : l.type === "group" && l.box ? Frame : l.type === "group" && l.boolean ? BOOLEAN[l.boolean] : KIND[l.type];
      const set = (patch: Partial<Layer>) => onPage({ ...p, layers: mapLayers(p.layers, (x) => (x.id === l.id ? ({ ...x, ...patch } as Layer) : x)) });
      const shutKey = `${p.id}/${l.id}`;
      const inner = isGroup(l) && !shut.includes(shutKey);
      // a layer a mask cuts sits in under it
      const indent = { paddingLeft: (p.loose ? 16 + depth * 14 : 36 + depth * 14 + (grouped ? 20 : 0)) + (cut.has(l.id) ? 12 : 0) };
      return (
        <div key={l.id}>
          {heads && (
            <div role="treeitem" data-group={l.group} aria-label={groupName(l.group) ?? "Group"} aria-selected={allOn} onClick={() => !dragging.current && onPick(k, members)} className={cn(ROW, allOn ? ON : "hover:bg-zinc-500/10")} style={{ paddingLeft: 36 + depth * 14 }}>
              <Group className="h-3 w-3 shrink-0 text-zinc-500 dark:text-[#b3b3b3]" />
              {/* the name its maker gave the group (an AI names its groups: "Palm trees"); one made by hand is a Group */}
              <span className="min-w-0 flex-1 truncate">{groupName(l.group) ?? "Group"}</span>
            </div>
          )}
          <div
            role="treeitem"
            data-row={key}
            {...(isGroup(l) ? { "data-container": "", "aria-expanded": inner } : {})}
            aria-label={layerName(l)}
            aria-selected={on}
            onPointerDown={(e) =>
              dragRow(
                e,
                (other) => other.startsWith(layerKey) && other !== key,
                (to) => {
                  // the list shows the front layer on top: above a row is in front of it
                  const next = moveRow(p, l.id, to.key.slice(layerKey.length), to.into ? "into" : to.after ? "behind" : "front");
                  if (next) onPage(next);
                },
              )
            }
            onPointerEnter={() => onPoint(l.id)}
            onPointerLeave={() => onPoint(null)}
            onClick={(e) => {
              if (dragging.current) return;
              if (e.shiftKey && run(k, l.id)) return;
              anchor.current = { page: p.id, layer: l.id };
              // picked layers are always of one container: one of another is picked alone
              const mine = k === at && selected.length && parentOf(p.layers, selected[0]!)?.id === parentOf(p.layers, l.id)?.id ? selected : [];
              onPick(k, e.shiftKey || e.metaKey || e.ctrlKey ? (mine.includes(l.id) ? mine.filter((id) => id !== l.id) : [...mine, l.id]) : [l.id]);
            }}
            onDoubleClick={() => setRenaming(key)}
            className={cn(ROW, on ? ON : "hover:bg-zinc-500/10", l.hidden && "text-zinc-500")}
            style={indent}
          >
            {isGroup(l) && (
              <button type="button" aria-label={inner ? "Close" : "Open"} onClick={(e) => (e.stopPropagation(), setShut((s) => (inner ? [...s, shutKey] : s.filter((x) => x !== shutKey))))} className="-ml-4 flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 dark:text-[#b3b3b3]">
                {inner ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
            )}
            <span data-icon onDoubleClick={zoomOn(k, l.id)} className="flex shrink-0" {...(l.mask && !combined ? { title: "Mask" } : cut.has(l.id) ? { "data-masked": "" } : {})}>
              <Icon className="h-3 w-3 shrink-0 text-zinc-500 dark:text-[#b3b3b3]" />
            </span>
            {renaming === key ? rename(layerName(l), (name) => set({ name: name || undefined })) : <span className="min-w-0 flex-1 truncate">{layerName(l)}</span>}
            {/* shown while designing only: never in a saved picture, a thumbnail or a video */}
            {l.reference && <span title="Shown while designing only, never in an export" className="shrink-0 rounded-[3px] border border-zinc-500/40 px-1 text-[9px] leading-[14px] text-zinc-500 dark:text-[#b3b3b3]">Reference</span>}
            <button type="button" aria-label={l.locked ? "Unlock" : "Lock"} aria-pressed={!!l.locked} onClick={(e) => (e.stopPropagation(), set({ locked: l.locked ? undefined : true }))} className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-zinc-500/20", !l.locked && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}>
              {l.locked ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
            </button>
            <button type="button" aria-label={l.hidden ? "Show" : "Hide"} aria-pressed={!!l.hidden} onClick={(e) => (e.stopPropagation(), set({ hidden: l.hidden ? undefined : true }))} className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-zinc-500/20", !l.hidden && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}>
              {l.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
            {line(key)}
          </div>
          {inner && <div role="group">{rows(p, k, l.layers, depth + 1, !!l.boolean)}</div>}
        </div>
      );
    });
  };

  return (
    <nav aria-label="Layers" className="flex w-60 shrink-0 flex-col border-r border-[#e6e6e6] bg-white text-[11px] text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#e6e6e6] pl-4 pr-2 dark:border-[#444]">
        <h2 className="font-semibold">Layers</h2>
        <Tip label="Add a frame" side="right">
          <button type="button" aria-label="Add a frame" onClick={onAddPage} className="flex h-6 w-6 items-center justify-center rounded-[5px] hover:bg-zinc-500/15">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </Tip>
      </div>
      <div role="tree" className="min-h-0 flex-1 select-none overflow-y-auto py-1">
        {pages.map((p, k) => {
          // layers lying loose on the canvas have no frame row: they stand on their own
          const open = p.loose || !shut.includes(p.id);
          const pageKey = `p:${p.id}`;
          return (
            <div key={p.id}>
              {!p.loose && (
              <div
                role="treeitem"
                data-row={pageKey}
                aria-label={pageName(p, k)}
                aria-expanded={open}
                aria-selected={(k === at && framed) || framedIds.includes(p.id)}
                onPointerDown={(e) =>
                  dragRow(
                    e,
                    (key) => key.startsWith("p:") && key !== pageKey,
                    (to) => {
                      const target = pages.findIndex((x) => `p:${x.id}` === to.key);
                      onMovePage(k, target + (to.after ? 1 : 0) - (k < target ? 1 : 0));
                    },
                  )
                }
                onClick={(e) => {
                  if (dragging.current) return;
                  if (e.shiftKey && run(k)) return;
                  anchor.current = { page: p.id };
                  // ⌘ or Ctrl (or Shift with nothing to run from): this frame joins the picked ones, or leaves them
                  if (!(e.shiftKey || e.metaKey || e.ctrlKey) || !framedIds.length) return onPick(k, [], true);
                  const next = framedIds.includes(p.id) ? framedIds.filter((id) => id !== p.id) : [...framedIds, p.id];
                  const first = pages.findIndex((x) => x.id === next[0]);
                  if (first < 0) onPick(k, []);
                  else onPick(first, [], true, next);
                }}
                onDoubleClick={() => setRenaming(pageKey)}
                className={cn(ROW, "pl-1 font-semibold", (k === at && framed) || framedIds.includes(p.id) ? ON : "hover:bg-zinc-500/10")}
              >
                <button type="button" aria-label={open ? "Close" : "Open"} onClick={(e) => (e.stopPropagation(), setShut((s) => (open ? [...s, p.id] : s.filter((id) => id !== p.id))))} className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 dark:text-[#b3b3b3]">
                  {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
                <span onDoubleClick={zoomOn(k)} className="flex shrink-0">
                  <Frame className="h-3 w-3 shrink-0 text-zinc-500 dark:text-[#b3b3b3]" />
                </span>
                {renaming === pageKey ? rename(pageName(p, k), (name) => onPage({ ...p, name: name || undefined })) : <span className="min-w-0 flex-1 truncate">{pageName(p, k)}</span>}
                {line(pageKey)}
              </div>
              )}
              {open && rows(p, k, p.layers, 0)}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
