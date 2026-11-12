import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, Circle, Eye, EyeOff, Frame, Image, Lock, LockOpen, PenTool, Plus, Square, Type } from "lucide-react";
import type { DesignPage, Layer } from "@contracts/design";
import { layerName, pageName } from "@/lib/design/hands";
import { cn } from "@/lib/utils";

/**
 * The layers list: every page with its layers under it, the front one on top. A click picks (Shift or ⌘ adds or
 * takes one), a double click on a name renames, the eye hides and the lock locks, and a row is dragged to a new place:
 * a layer among its page's layers, a page among the pages.
 */

const ROW = "group flex h-8 w-full cursor-default items-center gap-1.5 pr-2 text-left";
const ON = "bg-[#0d99ff]/20";
const KIND = { text: Type, image: Image, drawing: PenTool } as const;

type Drop = { key: string; after: boolean };

export function LayersPanel({
  pages,
  at,
  selected,
  framed,
  onPick,
  onPoint,
  onPage,
  onMovePage,
  onAddPage,
}: {
  pages: DesignPage[];
  at: number;
  selected: string[];
  framed: boolean;
  onPick: (at: number, ids: string[], framed?: boolean) => void;
  /** the layer the pointer is on, for the canvas to outline */
  onPoint: (id: string | null) => void;
  /** a page with a layer renamed, hidden, locked or moved (one step to undo) */
  onPage: (page: DesignPage) => void;
  onMovePage: (from: number, to: number) => void;
  onAddPage: () => void;
}) {
  const [shut, setShut] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const dragged = useRef<{ k: number; id?: string } | null>(null);
  const dropped = useRef(false);

  const rename = (was: string, done: (name: string) => void) => (
    <input
      autoFocus
      aria-label="Name"
      defaultValue={was}
      maxLength={60}
      onFocus={(e) => ((dropped.current = false), e.currentTarget.select())}
      onClick={(e) => e.stopPropagation()}
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
      className="h-6 min-w-0 flex-1 rounded-sm bg-white px-1 text-[11px] text-zinc-900 outline outline-1 outline-[#0d99ff] dark:bg-[#1e1e1e] dark:text-white"
    />
  );

  /** Dragging a row over another: above its middle goes before it, below goes after. */
  const dragOver = (e: React.DragEvent, key: string, fits: boolean) => {
    if (!fits) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (drop?.key !== key || drop.after !== after) setDrop({ key, after });
  };
  const line = (key: string) => drop?.key === key && <span className={cn("pointer-events-none absolute inset-x-2 h-0.5 bg-[#0d99ff]", drop.after ? "bottom-0" : "top-0")} />;
  const start = (e: React.DragEvent, what: { k: number; id?: string }) => {
    dragged.current = what;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
  };
  const end = () => ((dragged.current = null), setDrop(null));

  return (
    <nav aria-label="Layers" className="flex w-60 shrink-0 flex-col border-r border-[#e6e6e6] bg-white text-[11px] text-zinc-900 dark:border-[#444] dark:bg-[#2c2c2c] dark:text-white">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#e6e6e6] pl-4 pr-2 dark:border-[#444]">
        <h2 className="font-semibold">Layers</h2>
        <button type="button" aria-label="Add a page" title="Add a page" onClick={onAddPage} className="flex h-6 w-6 items-center justify-center rounded-[5px] hover:bg-zinc-500/15">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div role="tree" className="min-h-0 flex-1 select-none overflow-y-auto py-1" onDragEnd={end}>
        {pages.map((p, k) => {
          const open = !shut.includes(p.id);
          const pageKey = `p:${p.id}`;
          return (
            <div key={p.id}>
              <div
                role="treeitem"
                aria-label={pageName(p, k)}
                aria-expanded={open}
                aria-selected={k === at && framed}
                draggable={renaming !== pageKey}
                onDragStart={(e) => start(e, { k })}
                onDragOver={(e) => dragOver(e, pageKey, !!dragged.current && dragged.current.id === undefined)}
                onDrop={() => {
                  const from = dragged.current;
                  if (from && from.id === undefined && drop) onMovePage(from.k, k + (drop.after ? 1 : 0) - (from.k < k ? 1 : 0));
                  end();
                }}
                onClick={() => onPick(k, [], true)}
                onDoubleClick={() => setRenaming(pageKey)}
                className={cn(ROW, "relative pl-1 font-semibold", k === at && framed ? ON : "hover:bg-zinc-500/10")}
              >
                <button type="button" aria-label={open ? "Close" : "Open"} onClick={(e) => (e.stopPropagation(), setShut((s) => (open ? [...s, p.id] : s.filter((id) => id !== p.id))))} className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 dark:text-[#b3b3b3]">
                  {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
                <Frame className="h-3 w-3 shrink-0 text-zinc-500 dark:text-[#b3b3b3]" />
                {renaming === pageKey ? rename(pageName(p, k), (name) => onPage({ ...p, name: name || undefined })) : <span className="min-w-0 flex-1 truncate">{pageName(p, k)}</span>}
                {line(pageKey)}
              </div>
              {open &&
                [...p.layers].reverse().map((l) => {
                  const key = `l:${p.id}:${l.id}`;
                  const on = k === at && selected.includes(l.id);
                  const Icon = l.type === "shape" ? (l.shape === "ellipse" ? Circle : Square) : KIND[l.type];
                  const set = (patch: Partial<Layer>) => onPage({ ...p, layers: p.layers.map((x) => (x.id === l.id ? ({ ...x, ...patch } as Layer) : x)) });
                  return (
                    <div
                      key={l.id}
                      role="treeitem"
                      aria-label={layerName(l)}
                      aria-selected={on}
                      draggable={renaming !== key}
                      onDragStart={(e) => start(e, { k, id: l.id })}
                      onDragOver={(e) => dragOver(e, key, dragged.current?.k === k && dragged.current.id !== undefined && dragged.current.id !== l.id)}
                      onDrop={() => {
                        const from = dragged.current;
                        const moving = from?.k === k ? p.layers.find((x) => x.id === from.id) : undefined;
                        if (moving && drop) {
                          // the list shows the front layer on top: a place in the list is a place from the front
                          const shown = [...p.layers].reverse().filter((x) => x.id !== moving.id);
                          shown.splice(shown.findIndex((x) => x.id === l.id) + (drop.after ? 1 : 0), 0, moving);
                          onPage({ ...p, layers: shown.reverse() });
                        }
                        end();
                      }}
                      onPointerEnter={() => onPoint(l.id)}
                      onPointerLeave={() => onPoint(null)}
                      onClick={(e) => {
                        const mine = k === at ? selected : [];
                        onPick(k, e.shiftKey || e.metaKey || e.ctrlKey ? (mine.includes(l.id) ? mine.filter((id) => id !== l.id) : [...mine, l.id]) : [l.id]);
                      }}
                      onDoubleClick={() => setRenaming(key)}
                      className={cn(ROW, "relative pl-9", on ? ON : "hover:bg-zinc-500/10", l.hidden && "text-zinc-400 dark:text-[#7a7a7a]")}
                    >
                      <Icon className="h-3 w-3 shrink-0 text-zinc-500 dark:text-[#b3b3b3]" />
                      {renaming === key ? rename(layerName(l), (name) => set({ name: name || undefined })) : <span className="min-w-0 flex-1 truncate">{layerName(l)}</span>}
                      <button type="button" aria-label={l.locked ? "Unlock" : "Lock"} aria-pressed={!!l.locked} onClick={(e) => (e.stopPropagation(), set({ locked: l.locked ? undefined : true }))} className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-zinc-500/20", !l.locked && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}>
                        {l.locked ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
                      </button>
                      <button type="button" aria-label={l.hidden ? "Show" : "Hide"} aria-pressed={!!l.hidden} onClick={(e) => (e.stopPropagation(), set({ hidden: l.hidden ? undefined : true }))} className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-zinc-500/20", !l.hidden && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}>
                        {l.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </button>
                      {line(key)}
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
