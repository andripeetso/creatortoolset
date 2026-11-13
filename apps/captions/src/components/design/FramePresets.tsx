import { DESIGN_FORMATS } from "@contracts/design";
import type { ViewStore } from "@/lib/design/view";
import { ZoomMenu } from "./Inspector";

/**
 * The right panel while the frame tool is out, and on a canvas that has no frame yet: the picture sizes. A press on one
 * puts a frame of that size on the canvas; a drag on the canvas draws one of any size.
 */
export function FramePresets({ view, onZoom, onAdd }: { view: ViewStore; onZoom: (to: "in" | "out" | "fit" | "selection" | number) => void; onAdd: (size: { w: number; h: number }) => void }) {
  return (
    <aside aria-label="Design" className="flex w-60 shrink-0 flex-col overflow-y-scroll border-l border-[#e6e6e6] bg-white pb-20 text-[11px] text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#e6e6e6] pl-4 pr-2 dark:border-[#444]">
        <h2 className="font-semibold">Frame</h2>
        <ZoomMenu view={view} onZoom={onZoom} />
      </div>
      <ul aria-label="Frame sizes" className="flex flex-col py-2">
        {DESIGN_FORMATS.map((f) => (
          <li key={f.id}>
            <button type="button" onClick={() => onAdd({ w: f.w, h: f.h })} className="flex h-8 w-full items-center justify-between gap-3 px-4 text-left hover:bg-zinc-500/10">
              {f.name}
              <span className="text-zinc-500">
                {f.w} × {f.h}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
