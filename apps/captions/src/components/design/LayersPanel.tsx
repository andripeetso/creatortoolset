import { useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Circle, Eye, EyeOff, Frame, Group, Image, Lock, LockOpen, PenTool, Plus, Spline, Square, Star, Triangle, Type } from "lucide-react";
import type { DesignPage, Layer } from "@contracts/design";
import { groupName, layerName, pageName } from "@/lib/design/hands";
import { cn } from "@/lib/utils";
import { Tip } from "./Tip";

/**
 * The layers list: every frame of the canvas with its layers under it, the front one on top. A click picks (⌘ adds or
 * takes one; Shift picks every row from the last one clicked: the layers between, or the frames when the run goes past
 * a frame, never the layers a picked frame already holds), a double click on a name renames and one on its icon zooms
 * the canvas to it, the eye hides and the lock locks, and a row is dragged to a
 * new place: a layer among its frame's layers, a frame among the frames. Layers of a group lie under a Group row,
 * which picks them all; a layer's own row picks that layer alone (where two frames lie over each other, the
 * lower one in the list is drawn on top, and the list's order numbers the saved PNGs).
 */

const ROW = "group relative flex h-8 w-full cursor-default items-center gap-1.5 pr-2 text-left";
const ON = "bg-[#0d99ff]/20";
const KIND = { text: Type, image: Image, drawing: PenTool, path: Spline } as const;
const SHAPE = { rect: Square, ellipse: Circle, triangle: Triangle, star: Star, arrow: ArrowRight } as const;

type Drop = { key: string; after: boolean };

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
      const list = [...pages[k]!.layers].reverse().map((l) => l.id);
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
      to = key && r && fits(key) ? { key, after: ev.clientY > r.top + r.height / 2 } : null;
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
  const line = (key: string) => drop?.key === key && <span className={cn("pointer-events-none absolute inset-x-2 h-0.5 bg-[#0d99ff]", drop.after ? "bottom-0" : "top-0")} />;

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
          const layerKey = `l:${p.id}:`;
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
              {open &&
                [...p.layers].reverse().map((l, n, shown) => {
                  const key = layerKey + l.id;
                  // the first of a run of one group's layers gets the group's own row above it
                  // (a group that is down to one layer is a single layer again)
                  const members = l.group ? p.layers.filter((x) => x.group === l.group).map((x) => x.id) : [];
                  const grouped = members.length > 1;
                  const heads = grouped && shown[n - 1]?.group !== l.group;
                  const allOn = k === at && members.length > 0 && members.every((id) => selected.includes(id));
                  const on = k === at && selected.includes(l.id);
                  const Icon = l.type === "shape" ? SHAPE[l.shape] : KIND[l.type];
                  const set = (patch: Partial<Layer>) => onPage({ ...p, layers: p.layers.map((x) => (x.id === l.id ? ({ ...x, ...patch } as Layer) : x)) });
                  return (
                    <div key={l.id}>
                    {heads && (
                      <div role="treeitem" data-group={l.group} aria-label={groupName(l.group) ?? "Group"} aria-selected={allOn} onClick={() => !dragging.current && onPick(k, members)} className={cn(ROW, "pl-9", allOn ? ON : "hover:bg-zinc-500/10")}>
                        <Group className="h-3 w-3 shrink-0 text-zinc-500 dark:text-[#b3b3b3]" />
                        {/* the name its maker gave the group (an AI names its groups: "Palm trees"); one made by hand is a Group */}
                        <span className="min-w-0 flex-1 truncate">{groupName(l.group) ?? "Group"}</span>
                      </div>
                    )}
                    <div
                      role="treeitem"
                      data-row={key}
                      aria-label={layerName(l)}
                      aria-selected={on}
                      onPointerDown={(e) =>
                        dragRow(
                          e,
                          (other) => other.startsWith(layerKey) && other !== key,
                          (to) => {
                            // the list shows the front layer on top: a place in the list is a place from the front
                            const shown = [...p.layers].reverse().filter((x) => x.id !== l.id);
                            shown.splice(shown.findIndex((x) => layerKey + x.id === to.key) + (to.after ? 1 : 0), 0, l);
                            onPage({ ...p, layers: shown.reverse() });
                          },
                        )
                      }
                      onPointerEnter={() => onPoint(l.id)}
                      onPointerLeave={() => onPoint(null)}
                      onClick={(e) => {
                        if (dragging.current) return;
                        if (e.shiftKey && run(k, l.id)) return;
                        anchor.current = { page: p.id, layer: l.id };
                        const mine = k === at ? selected : [];
                        onPick(k, e.shiftKey || e.metaKey || e.ctrlKey ? (mine.includes(l.id) ? mine.filter((id) => id !== l.id) : [...mine, l.id]) : [l.id]);
                      }}
                      onDoubleClick={() => setRenaming(key)}
                      className={cn(ROW, p.loose ? "pl-4" : grouped ? "pl-14" : "pl-9", on ? ON : "hover:bg-zinc-500/10", l.hidden && "text-zinc-500")}
                    >
                      <span data-icon onDoubleClick={zoomOn(k, l.id)} className="flex shrink-0">
                        <Icon className="h-3 w-3 shrink-0 text-zinc-500 dark:text-[#b3b3b3]" />
                      </span>
                      {renaming === key ? rename(layerName(l), (name) => set({ name: name || undefined })) : <span className="min-w-0 flex-1 truncate">{layerName(l)}</span>}
                      <button type="button" aria-label={l.locked ? "Unlock" : "Lock"} aria-pressed={!!l.locked} onClick={(e) => (e.stopPropagation(), set({ locked: l.locked ? undefined : true }))} className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-zinc-500/20", !l.locked && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}>
                        {l.locked ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
                      </button>
                      <button type="button" aria-label={l.hidden ? "Show" : "Hide"} aria-pressed={!!l.hidden} onClick={(e) => (e.stopPropagation(), set({ hidden: l.hidden ? undefined : true }))} className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-zinc-500/20", !l.hidden && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}>
                        {l.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </button>
                      {line(key)}
                    </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
