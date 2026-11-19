import { Check, Eye, EyeOff, Minus, Plus, X } from "lucide-react";
import { DESIGN_AIDS, DESIGN_SAFE, type DesignGrid, type DesignPage } from "@contracts/design";
import { Choice, Colour, Num, Section, Tap } from "./Inspector";
import { cn } from "@/lib/utils";

const KINDS = [["columns", "Columns"], ["rows", "Rows"], ["grid", "Grid"]] as const;

/** The frame's aids in its Inspector: its layout grids, its guides (made from the rulers) and the parts Instagram cuts or covers. */
export function FrameAids({ page, onPage, colours, onDropper }: { page: DesignPage; onPage: (page: DesignPage, merge?: string) => void; colours: readonly string[]; onDropper: (take: (hex: string) => void) => void }) {
  const grids = page.grids ?? [];
  const w = page.w ?? 1080;
  const setGrids = (next: DesignGrid[], merge?: string) => onPage({ ...page, grids: next.length ? next : undefined }, merge);
  const setGrid = (n: number, patch: Partial<DesignGrid>, merge?: string) => setGrids(grids.map((g, i) => (i === n ? { ...g, ...patch } : g)), merge);
  // a new grid: four columns with the margins a carousel slide usually keeps
  const fresh: DesignGrid = { kind: "columns", count: 4, gutter: Math.round(w * 0.025), margin: Math.round(w * 0.07), color: "#ff0000" };
  const safe = page.safe ?? [];
  return (
    <>
      <Section
        title="Layout grid"
        action={
          grids.length < DESIGN_AIDS.grids && (
            <Tap label="Add layout grid" onClick={() => setGrids([...grids, fresh])}>
              <Plus className="h-3.5 w-3.5" />
            </Tap>
          )
        }
      >
        {grids.map((g, n) => (
          <div key={n} data-grid-row={n} className="flex flex-col gap-2">
            <div className="flex items-center gap-1">
              <div className="flex-1">
                <Choice label="Grid kind" value={g.kind} options={KINDS} onPick={(kind) => setGrid(n, kind === "grid" ? { kind, size: g.size ?? 8, count: undefined, gutter: undefined, margin: undefined } : { kind, count: g.count ?? 4, gutter: g.gutter ?? 0, margin: g.margin ?? 0, size: undefined })} />
              </div>
              <Tap label={g.hidden ? "Show grid" : "Hide grid"} on={g.hidden} onClick={() => setGrid(n, { hidden: g.hidden ? undefined : true })}>
                {g.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Tap>
              <Tap label="Remove grid" onClick={() => setGrids(grids.filter((_, i) => i !== n))}>
                <Minus className="h-3.5 w-3.5" />
              </Tap>
            </div>
            {g.kind === "grid" ? (
              <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                <Num label="Size" title="Cell size in pixels" value={g.size ?? 8} min={1} max={4096} onCommit={(size) => setGrid(n, { size })} />
                <Colour title="Grid colour" value={g.color} colours={colours} onDropper={onDropper} onSet={(color, merge) => setGrid(n, { color }, merge)} />
              </div>
            ) : (
              <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
                <Num label="#" title={g.kind === "columns" ? "Columns" : "Rows"} value={g.count ?? 4} min={1} max={DESIGN_AIDS.count} onCommit={(count) => setGrid(n, { count })} />
                <Num label="Gut" title="Gutter in pixels" value={g.gutter ?? 0} min={0} max={4096} onCommit={(gutter) => setGrid(n, { gutter })} />
                <Num label="Mar" title="Margin in pixels" value={g.margin ?? 0} min={0} max={4096} onCommit={(margin) => setGrid(n, { margin })} />
                <Colour title="Grid colour" value={g.color} colours={colours} onDropper={onDropper} onSet={(color, merge) => setGrid(n, { color }, merge)} />
              </div>
            )}
          </div>
        ))}
      </Section>
      {!!page.guides?.length && (
        <Section
          title="Guides"
          action={
            <Tap label="Remove guides" onClick={() => onPage({ ...page, guides: undefined })}>
              <X className="h-3.5 w-3.5" />
            </Tap>
          }
        >
          <span className="text-zinc-500 dark:text-[#b3b3b3]">{page.guides.length === 1 ? "1 guide" : `${page.guides.length} guides`}</span>
        </Section>
      )}
      <Section title="Safe zones">
        <div role="group" aria-label="Safe zones" className="flex flex-col">
          {DESIGN_SAFE.map((z) => {
            const on = safe.includes(z.id);
            return (
              <button
                key={z.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => {
                  const next = on ? safe.filter((s) => s !== z.id) : DESIGN_SAFE.map((d) => d.id).filter((id) => id === z.id || safe.includes(id));
                  onPage({ ...page, safe: next.length ? next : undefined });
                }}
                className="flex h-6 items-center gap-2 rounded-[5px] px-1 text-left hover:bg-zinc-500/15"
              >
                <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border", on ? "border-[#0d99ff] bg-[#0d99ff] text-white" : "border-zinc-400 dark:border-[#666]")}>{on && <Check className="h-2.5 w-2.5" />}</span>
                {z.name}
              </button>
            );
          })}
        </div>
      </Section>
    </>
  );
}
