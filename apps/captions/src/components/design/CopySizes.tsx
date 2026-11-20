import { useState, type ComponentType, type ReactNode } from "react";
import { DESIGN_FORMATS, DESIGN_LIMITS } from "@contracts/design";

type Item = ComponentType<{ onSelect?: (e: Event) => void; className?: string; children?: ReactNode }>;

/**
 * The sizes a frame can be copied in, as items of the menu they are in (the frame's right-click menu, the properties
 * panel's): each format, then a size of one's own typed in. The frame's own size is left out of the formats.
 */
export function CopySizes({ Item, from, onCopy }: { Item: Item; from: { w: number; h: number }; onCopy: (size: { w: number; h: number; name: string }) => void }) {
  const [w, setW] = useState(from.w);
  const [h, setH] = useState(from.h);
  const fit = (n: number) => Math.min(DESIGN_LIMITS.frameMax, Math.max(DESIGN_LIMITS.frameMin, Math.round(n) || DESIGN_LIMITS.frameMin));
  const field = (label: string, value: number, set: (n: number) => void) => (
    <label className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-[5px] bg-zinc-500/10 px-1.5">
      <span className="text-zinc-500">{label}</span>
      <input
        aria-label={label === "W" ? "Width of the copy" : "Height of the copy"}
        inputMode="numeric"
        value={value}
        onChange={(e) => set(Number(e.currentTarget.value.replace(/\D/g, "")) || 0)}
        // the menu's own keys (type to find an item, arrows) are not for this field; Escape still closes it
        onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
        className="w-full min-w-0 bg-transparent tabular-nums outline-none"
      />
    </label>
  );
  return (
    <>
      {DESIGN_FORMATS.filter((f) => f.w !== from.w || f.h !== from.h).map((f) => (
        <Item key={f.id} onSelect={() => onCopy({ w: f.w, h: f.h, name: f.name })} className="flex justify-between gap-4">
          {f.name}
          <span className="text-zinc-500">
            {f.w} × {f.h}
          </span>
        </Item>
      ))}
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-xs">
        {field("W", w, setW)}
        {field("H", h, setH)}
      </div>
      <Item onSelect={() => onCopy({ w: fit(w), h: fit(h), name: `${fit(w)} × ${fit(h)}` })}>Copy at this size</Item>
    </>
  );
}
