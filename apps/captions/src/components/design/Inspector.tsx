import { useRef, useState, type ReactNode } from "react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceAround,
  Ban,
  CaseUpper,
  Check,
  ChevronDown,
  CircleDot,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Link2,
  Minus,
  Plus,
  RotateCcw,
  Scan,
  Ungroup,
  Unlink2,
  WrapText,
} from "lucide-react";
import type { Design, DesignPage, Gradient, Layer, Stroke } from "@contracts/design";
import { DESIGN_ADJUST, DESIGN_BLENDS, DESIGN_FORMATS, DESIGN_LIMITS, DESIGN_SHAPES } from "@contracts/design";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { typedHex } from "@/lib/design/colour";
import { boundsOf, frameOf, groupName, pageName, resizeAll, SHAPE_NAMES, type Align } from "@/lib/design/hands";
import { DESIGN_FONTS, designWeight } from "@/lib/design/fonts";
import { useZoom, type ViewStore } from "@/lib/design/view";
import { ColourPicker } from "./ColourPicker";
import { Tip } from "./Tip";
import { cn } from "@/lib/utils";

/**
 * The properties of what is picked: where it is, its size, how it looks, its fill and line, its type. No layer picked:
 * the frame's own (its name, its place on the canvas, its size, its colour). A number is typed (Enter or leaving the field sets it, the arrows step it, Shift by ten) or dragged
 * by its label; while it is dragged the canvas shows it, and it is one step to undo when let go. A choice made in a
 * menu here gives the keys back to the canvas at once: ⌘Z right after picking a font undoes the font.
 */

const FIELD = "flex h-6 min-w-0 items-center gap-1.5 rounded-[5px] border border-transparent bg-[#f5f5f5] px-1.5 focus-within:border-[#0d99ff] hover:border-[#e6e6e6] focus-within:hover:border-[#0d99ff] dark:bg-[#383838] dark:hover:border-[#4d4d4d]";
const DIM = "text-zinc-500 dark:text-[#b3b3b3]";
const round = (n: number) => Math.round(n * 100) / 100;

function Num({ label, title, value, onLive, onCommit, min = -Infinity, max = Infinity, step = 1 }: { label: ReactNode; title: string; value: number | null; onLive?: (n: number | null) => void; onCommit: (n: number) => void; min?: number; max?: number; step?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const dropped = useRef(false);
  const fit = (n: number) => round(Math.min(max, Math.max(min, n)));
  const set = (text: string) => {
    const n = Number(text.replace(",", "."));
    if (text.trim() !== "" && Number.isFinite(n) && fit(n) !== value) onCommit(fit(n));
  };
  /** The label is a handle: dragged sideways it steps the number, a pixel a step. */
  const scrub = (e: React.PointerEvent) => {
    if (value === null) return;
    e.preventDefault();
    const x0 = e.clientX;
    let last = value;
    const move = (ev: PointerEvent) => {
      last = fit(value + Math.round(ev.clientX - x0) * step);
      onLive?.(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (last !== value) onCommit(last);
      else onLive?.(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    // not a <label>: a click that ends a drag on it would put the keys in the field
    <Tip label={title}>
    <div data-field={title} className={FIELD}>
      <span onPointerDown={scrub} className={cn("flex shrink-0 cursor-ew-resize select-none items-center", DIM)}>
        {label}
      </span>
      <input
        aria-label={title}
        inputMode="decimal"
        value={draft ?? (value === null ? "" : String(round(value)))}
        placeholder={value === null ? "Mixed" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => ((dropped.current = false), e.currentTarget.select())}
        onBlur={(e) => {
          if (draft !== null && !dropped.current) set(e.currentTarget.value);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            dropped.current = true;
            e.currentTarget.blur();
          }
          else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value !== null) {
            e.preventDefault();
            setDraft(null);
            onCommit(fit((Number(draft ?? value) || 0) + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
          }
        }}
        className="w-full min-w-0 bg-transparent outline-none placeholder:text-zinc-400"
      />
    </div>
    </Tip>
  );
}

/**
 * A colour: the swatch opens the picker (ColourPicker), the field beside it takes a hex code. Every colour the picker
 * passes is set at once, and `merge` names the drag or press it belongs to, so each is one step to undo.
 */
function Colour({ title, value, colours, onSet, onDropper }: { title: string; value: string | null; colours: readonly string[]; onSet: (c: string, merge?: string) => void; onDropper?: (take: (hex: string) => void) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // each opening is a picking of its own: its drags never join the last opening's
  const opened = useRef(0);
  const hex = value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <div className={cn(FIELD, "flex-1")}>
      <Popover open={open} onOpenChange={(now) => (now && opened.current++, setOpen(now))}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={title}
            className="h-4 w-4 shrink-0 rounded-sm border border-black/15 dark:border-white/20"
            style={{ background: value === null ? "repeating-linear-gradient(45deg, #888 0 3px, #bbb 3px 6px)" : hex }}
          />
        </PopoverTrigger>
        <PopoverContent side="left" align="start" sideOffset={14} className="w-auto border-[#e6e6e6] bg-white p-3 text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]">
          <ColourPicker
            value={hex}
            colours={colours}
            onSet={(c, gesture) => onSet(c, `${title} ${opened.current}.${gesture}`)}
            onDropper={
              onDropper &&
              (() => {
                setOpen(false);
                onDropper((c) => onSet(c));
              })
            }
          />
        </PopoverContent>
      </Popover>
      <input
        aria-label={`${title} as a hex code`}
        value={draft ?? (value === null ? "" : value.slice(1).toUpperCase())}
        placeholder={value === null ? "Mixed" : undefined}
        maxLength={7}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())}
        onBlur={(e) => {
          const typed = typedHex(e.currentTarget.value);
          if (draft !== null && typed && typed !== value) onSet(typed);
          setDraft(null);
        }}
        className="w-full min-w-0 bg-transparent uppercase outline-none placeholder:normal-case placeholder:text-zinc-400"
      />
    </div>
  );
}

const Section = ({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) => (
  <section aria-label={title} className="flex flex-col gap-2 border-b border-[#e6e6e6] px-4 py-3 dark:border-[#444]">
    <div className="flex h-6 items-center justify-between">
      <h3 className="font-semibold">{title}</h3>
      {action}
    </div>
    {children}
  </section>
);

const Tap = ({ label, on, disabled, onClick, children }: { label: string; on?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) => (
  <Tip label={label}>
    <button type="button" aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick} className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] disabled:opacity-30", on ? "bg-[#0d99ff]/20 text-[#0d99ff]" : "hover:bg-zinc-500/15")}>
      {children}
    </button>
  </Tip>
);

/** The shadow a press on + gives. */
const SHADOW = { color: "#000000", opacity: 0.35, blur: 24, x: 0, y: 8 };
/** The gradient a press on + gives: down the box, to black. */
const GRADIENT = { to: "#000000", angle: 90 };
const GRADIENT_KINDS = [["linear", "Linear"], ["radial", "Radial"]] as const;
const CORNERS = [["◜", "Top left corner"], ["◝", "Top right corner"], ["◞", "Bottom right corner"], ["◟", "Bottom left corner"]] as const;
const BLEND_NAMES = { multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken", lighten: "Lighten", "soft-light": "Soft light" } as const;
/** How a frame or the picked layers are saved as pictures: PNG or JPEG, at their size or twice it. */
export interface ExportAs {
  jpeg: boolean;
  scale: number;
}

const ADJUST_NAMES = { exposure: "Exposure", contrast: "Contrast", highlights: "Highlights", shadows: "Shadows", warmth: "Warmth", tint: "Tint", saturation: "Saturation" } as const;

/**
 * A setting on a line: its name, a track to drag and its number. While it is dragged the canvas shows it, and it is
 * one step to undo when let go; the arrows step it (Shift: by ten) and a double click puts it back to nothing.
 */
function Slide({ label, value, min, max, onLive, onCommit }: { label: string; value: number | null; min: number; max: number; onLive: (n: number | null) => void; onCommit: (n: number) => void }) {
  const v = value ?? 0;
  const part = (n: number) => (n - min) / (max - min);
  const at = (x: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return Math.round(min + Math.min(1, Math.max(0, (x - r.left) / r.width)) * (max - min));
  };
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.focus();
    let last = at(e.clientX, el);
    onLive(last);
    const move = (ev: PointerEvent) => onLive((last = at(ev.clientX, el)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      // the keys go back to the canvas: Space still drags it, ⌘Z still undoes
      el.blur();
      if (last !== value) onCommit(last);
      else onLive(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    <div className="grid grid-cols-[4.25rem_1fr_1.75rem] items-center gap-2">
      <span className={cn("truncate", DIM)}>{label}</span>
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={v}
        tabIndex={0}
        onPointerDown={drag}
        onDoubleClick={() => v && onCommit(0)}
        onKeyDown={(e) => {
          const by = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
          if (!by) return;
          e.preventDefault();
          e.stopPropagation();
          onCommit(Math.min(max, Math.max(min, v + by * (e.shiftKey ? 10 : 1))));
        }}
        className="relative h-6 cursor-ew-resize touch-none outline-none"
      >
        <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded bg-zinc-500/30" />
        <div className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-[#0d99ff]" style={{ left: `${Math.min(part(0), part(v)) * 100}%`, width: `${Math.abs(part(v) - part(Math.max(min, 0))) * 100}%` }} />
        <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#0d99ff] bg-white shadow-sm" style={{ left: `${part(v) * 100}%` }} />
      </div>
      <span className="text-right tabular-nums">{value === null ? "…" : v}</span>
    </div>
  );
}

/** A choice of a few, as a row of buttons with the chosen one raised. */
/** The zoom as a percentage. It reads the view itself: a wheel on the canvas draws this number again and nothing else of the panel. */
const ZoomNumber = ({ view }: { view: ViewStore }) => <>{Math.round(useZoom(view) * 100)}%</>;

/** The zoom's number and its menu (in, out, fit, selection, 50, 100, 200 %). */
export function ZoomMenu({ view, onZoom }: { view: ViewStore; onZoom: (to: "in" | "out" | "fit" | "selection" | number) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Zoom" className="flex h-6 items-center gap-0.5 rounded-[5px] px-1.5 hover:bg-zinc-500/15">
        <ZoomNumber view={view} />
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => onZoom("in")}>
          Zoom in<DropdownMenuShortcut>+</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onZoom("out")}>
          Zoom out<DropdownMenuShortcut>−</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onZoom("fit")}>
          Zoom to fit<DropdownMenuShortcut>⇧1</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onZoom("selection")}>
          Zoom to selection<DropdownMenuShortcut>⇧2</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onZoom(0.5)}>Zoom to 50%</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onZoom(1)}>
          Zoom to 100%<DropdownMenuShortcut>⇧0</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onZoom(2)}>Zoom to 200%</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Choice<V extends string | number>({ label, value, options, onPick }: { label: string; value: V | null; options: readonly (readonly [V, string])[]; onPick: (v: V) => void }) {
  return (
    <div role="group" aria-label={label} className="grid gap-1 rounded-[5px] bg-[#f5f5f5] p-0.5 dark:bg-[#383838]" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([v, name]) => (
        <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onPick(v)} className={cn("h-5 rounded-[4px]", value === v ? "bg-white shadow-sm dark:bg-[#5a5a5a]" : DIM)}>
          {name}
        </button>
      ))}
    </div>
  );
}

/** A choice of many, as a field that opens a list. */
function PickOne<V extends string>({ label, value, options, onPick }: { label: string; value: string; options: readonly (readonly [V, string])[]; onPick: (v: V) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={label} className={cn(FIELD, "w-full justify-between outline-none")}>
        <span className="truncate">{value}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {options.map(([v, name]) => (
          <DropdownMenuItem key={v} onSelect={() => onPick(v)} className="flex items-center justify-between gap-2">
            {name}
            {name === value && <Check className="h-3.5 w-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ALIGNS: [Align, string, typeof AlignLeft][] = [
  ["left", "Align left", AlignStartVertical],
  ["center", "Align horizontal centres", AlignCenterVertical],
  ["right", "Align right", AlignEndVertical],
  ["top", "Align top", AlignStartHorizontal],
  ["middle", "Align vertical centres", AlignCenterHorizontal],
  ["bottom", "Align bottom", AlignEndHorizontal],
];

export function Inspector({
  design,
  page,
  at,
  count,
  picked,
  onPreview,
  onPatch,
  onPage,
  onPagePreview,
  onAlign,
  onDistribute,
  view,
  onZoom,
  framesPicked,
  onExport,
  cropping,
  onCrop,
  onCutOut,
  cutting,
  onGroup,
  onUngroup,
  colours,
  onDropper,
}: {
  design: Design;
  page: DesignPage;
  at: number;
  /** how many frames the design has */
  count: number;
  /** the picked layers of the page, as the canvas shows them */
  picked: Layer[];
  /** what the canvas shows while a number or a colour is being dragged; null: back to what is saved */
  onPreview: (fn: ((l: Layer) => Layer) | null) => void;
  /** every picked layer through `fn`: one step to undo (`merge`: joined to the step before it of the same name) */
  onPatch: (fn: (l: Layer) => Layer, merge?: string) => void;
  /** the frame's own name, place, size and background (`merge` as above) */
  onPage: (page: DesignPage, merge?: string) => void;
  /** the frame as the canvas shows it while one of its numbers is dragged; null: back to what is saved */
  onPagePreview: (page: DesignPage | null) => void;
  onAlign: (how: Align) => void;
  onDistribute: (axis: "x" | "y") => void;
  /** the canvas's view: only the zoom's number reads it, and only that is drawn again when it moves */
  view: ViewStore;
  onZoom: (to: "in" | "out" | "fit" | "selection" | number) => void;
  /** every frame, or the one at this place, saved as said */
  /** the frames that are picked, by their place in the list (none when layers are) */
  framesPicked: readonly number[];
  onExport: (only: number | readonly number[] | undefined, as: ExportAs) => void;
  /** the picked picture is being moved inside its box (the canvas's crop), and the switch for it */
  cropping: boolean;
  onCrop: (on: boolean) => void;
  /** the picked picture's background taken away (a Mac of the person's own cuts it out); `cutting`: one is being cut */
  onCutOut: () => void;
  cutting: boolean;
  /** the picked layers made one group, and the groups they are in taken apart */
  onGroup: () => void;
  onUngroup: () => void;
  /** the colours the design already uses, for the picker */
  colours: readonly string[];
  /** the next press on the canvas gives its colour to `take` */
  onDropper: (take: (hex: string) => void) => void;
}) {
  const [ratio, setRatio] = useState(false);
  /** Each corner's radius shown by itself. */
  const [split, setSplit] = useState(false);
  const [as, setAs] = useState<ExportAs>({ jpeg: false, scale: 1 });
  const one = picked.length === 1 ? picked[0]! : null;
  const box = one ?? (picked.length ? boundsOf(picked) : null);
  /** What every picked layer has in common, or null when they differ (or one has none). */
  const same = <V,>(of: (l: Layer) => V | undefined): V | null => {
    const first = picked[0] ? of(picked[0]) : undefined;
    return first !== undefined && picked.every((l) => of(l) === first) ? first : null;
  };
  const every = (is: (l: Layer) => boolean) => picked.length > 0 && picked.every(is);
  /** A number field for the picked layers: `to` gives each layer with the number set. */
  const num = (label: ReactNode, title: string, value: number | null, to: (n: number) => (l: Layer) => Layer, more: { min?: number; max?: number; step?: number } = {}) => (
    <Num label={label} title={title} value={value} {...more} onLive={(n) => onPreview(n === null ? null : to(n))} onCommit={(n) => onPatch(to(n))} />
  );
  /** A slider for the picked layers, like `num`. */
  const slide = (label: string, value: number | null, to: (n: number) => (l: Layer) => Layer, min: number, max: number) => (
    <Slide key={label} label={label} value={value} min={min} max={max} onLive={(n) => onPreview(n === null ? null : to(n))} onCommit={(n) => onPatch(to(n))} />
  );
  const colour = (title: string, value: string | null, to: (c: string) => (l: Layer) => Layer) => <Colour title={title} value={value} colours={colours} onDropper={onDropper} onSet={(c, merge) => onPatch(to(c), merge)} />;
  /** The picked layers resized so the box round them is `w` × `h` (one layer: that layer; with the lock, in its shape). */
  const sized = (w: number, h: number) => (l: Layer) => (box ? resizeAll([l], box, { x: box.x, y: box.y, w, h })[0]! : l);

  const text = every((l) => l.type === "text");
  const shape = every((l) => l.type === "shape");
  /** A shape or a path: what has a fill and a line of its own. */
  const lined = every((l) => l.type === "shape" || l.type === "path");
  const image = every((l) => l.type === "image");
  /** The gradient of a text or a shape (a picture and a drawing have none). */
  const gradOf = (l: Layer) => (l.type === "shape" || l.type === "path" || l.type === "text" ? l.gradient : undefined);
  /** A layer's gradient with these of its settings changed (the others stay); undefined takes the gradient off. */
  const setGrad = (g: Partial<Gradient> | undefined) => (l: Layer): Layer =>
    // (a gradient runs from the fill's colour: a path with no fill gets one with it)
    l.type === "shape" || l.type === "path" || l.type === "text" ? { ...l, ...(g && l.type === "path" && !l.fill ? { fill: "#d9d9d9" } : {}), gradient: g && { ...GRADIENT, ...l.gradient, ...g } } : l;
  /** A corner's radius of a picture or a rectangle (0: top left, then round the box), and that corner set. */
  const cornerOf = (l: Layer, n: number): number | undefined => (l.type === "image" || l.type === "shape" ? (typeof l.radius === "object" ? l.radius[n]! : (l.radius ?? 0)) : undefined);
  const setCorner = (n: number, v: number) => (l: Layer): Layer => {
    if (l.type !== "image" && l.type !== "shape") return l;
    const r = [0, 1, 2, 3].map((k) => (k === n ? v : (cornerOf(l, k) ?? 0))) as [number, number, number, number];
    return { ...l, radius: r.every((x) => x === r[0]) ? r[0] || undefined : r };
  };
  const hasGrad = picked.some(gradOf);
  /** A + or − beside a section's name, for the one thing the section can add. */
  const addOrRemove = (has: boolean, what: string, add: () => void, remove: () => void) =>
    has ? (
      <Tap label={`Remove the ${what}`} onClick={remove}>
        <Minus className="h-3.5 w-3.5" />
      </Tap>
    ) : (
      <Tap label={`Add a ${what}`} onClick={add}>
        <Plus className="h-3.5 w-3.5" />
      </Tap>
    );
  const hasLine = picked.some((l) => ((l.type === "shape" || l.type === "path") && l.stroke) || (l.type === "text" && l.outline));
  const setLine = (v: { color: string; width: number } | undefined) => (l: Layer): Layer => (l.type === "shape" || l.type === "path" ? { ...l, stroke: v && { ...l.stroke, ...v } } : l.type === "text" ? { ...l, outline: v } : l);
  /** A shape's own line (its dashes, ends and side), and those set. */
  const strokeOf = (l: Layer) => (l.type === "shape" || l.type === "path" ? l.stroke : undefined);
  const setStroke = (more: Partial<Stroke>) => (l: Layer): Layer => ((l.type === "shape" || l.type === "path") && l.stroke ? { ...l, stroke: { ...l.stroke, ...more } } : l);
  const setDash = (dash: number, gap: number) => setStroke({ dash: gap > 0 ? [dash, gap] : undefined });
  const lineOf = (l: Layer) => (l.type === "shape" || l.type === "path" ? l.stroke : l.type === "text" ? l.outline : undefined);
  const frame = frameOf(page, at, design.width, design.height);
  /** A number field of the frame itself. */
  const fnum = (label: string, title: string, value: number, set: (n: number) => Partial<DesignPage>, more: { min: number; max: number }) => (
    <Num label={label} title={title} value={value} {...more} onLive={(n) => onPagePreview(n === null ? null : { ...page, ...set(n) })} onCommit={(n) => onPage({ ...page, ...set(n) })} />
  );
  const far = { min: -DESIGN_LIMITS.canvas, max: DESIGN_LIMITS.canvas };
  const big = { min: DESIGN_LIMITS.frameMin, max: DESIGN_LIMITS.frameMax };

  return (
    <aside aria-label="Design" className="flex w-60 shrink-0 flex-col overflow-y-scroll border-l pb-20 border-[#e6e6e6] bg-white text-[11px] text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#e6e6e6] pl-4 pr-2 dark:border-[#444]">
        <h2 className="font-semibold">{picked.length > 1 ? (picked[0]!.group && picked.every((l) => l.group === picked[0]!.group) ? (groupName(picked[0]!.group) ?? `Group of ${picked.length}`) : `${picked.length} selected`) : one ? (one.type === "text" ? "Text" : one.type === "image" ? "Picture" : one.type === "drawing" ? "Drawing" : one.type === "path" ? "Path" : SHAPE_NAMES[one.shape]) : framesPicked.length > 1 ? `${framesPicked.length} frames` : "Frame"}</h2>
        <div className="flex items-center">
          {picked.some((l) => l.group && page.layers.filter((x) => x.group === l.group).length > 1) && (
            <Tap label="Ungroup" onClick={onUngroup}>
              <Ungroup className="h-3.5 w-3.5" />
            </Tap>
          )}
          {picked.length > 1 && !(picked[0]!.group && picked.every((l) => l.group === picked[0]!.group)) && (
            <Tap label="Group" onClick={onGroup}>
              <Group className="h-3.5 w-3.5" />
            </Tap>
          )}
        <ZoomMenu view={view} onZoom={onZoom} />
        </div>
      </div>

      {/* several frames picked: what one frame is (its name, place, size and fill) is not shown for them all */}
      {!box && framesPicked.length < 2 && (
        <>
          <Section title="Frame">
            <input
              key={`${page.id}:${page.name ?? ""}`}
              aria-label="The frame's name"
              defaultValue={pageName(page, at)}
              maxLength={60}
              onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())}
              onBlur={(e) => e.currentTarget.value.trim() !== pageName(page, at) && onPage({ ...page, name: e.currentTarget.value.trim() || undefined })}
              className={cn(FIELD, "outline-none")}
            />
            <div className="grid grid-cols-2 gap-2">
              {fnum("X", "X", frame.x, (n) => ({ x: n, y: frame.y }), far)}
              {fnum("Y", "Y", frame.y, (n) => ({ x: frame.x, y: n }), far)}
              {fnum("W", "Width", frame.w, (n) => ({ w: n, h: frame.h }), big)}
              {fnum("H", "Height", frame.h, (n) => ({ w: frame.w, h: n }), big)}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Frame size" className={cn(FIELD, "w-full justify-between outline-none")}>
                <span className="truncate">{DESIGN_FORMATS.find((f) => f.w === frame.w && f.h === frame.h)?.name ?? "Own size"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {DESIGN_FORMATS.map((f) => (
                  <DropdownMenuItem key={f.id} onSelect={() => onPage({ ...page, w: f.w, h: f.h })} className="flex justify-between gap-4">
                    {f.name}
                    <span className={DIM}>
                      {f.w} × {f.h}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </Section>
          <Section title="Fill" action={addOrRemove(!!page.gradient, "gradient", () => onPage({ ...page, gradient: GRADIENT }), () => onPage({ ...page, gradient: undefined }))}>
            <div className="flex">
              <Colour title="The frame's colour" value={page.background} colours={colours} onDropper={onDropper} onSet={(background, merge) => onPage({ ...page, background }, merge)} />
            </div>
            {page.gradient && (
              <div className="grid grid-cols-[1fr_4.5rem] gap-2">
                <Colour title="Gradient to" value={page.gradient.to} colours={colours} onDropper={onDropper} onSet={(to, merge) => onPage({ ...page, gradient: { ...page.gradient!, to } }, merge)} />
                <Num label="∠" title="Gradient angle in degrees" value={page.gradient.angle} min={-360} max={360} onLive={(n) => onPagePreview(n === null ? null : { ...page, gradient: { ...page.gradient!, angle: n } })} onCommit={(n) => onPage({ ...page, gradient: { ...page.gradient!, angle: n } })} />
              </div>
            )}
            {page.gradient && (
              <>
                <Choice label="Gradient kind" value={page.gradient.kind ?? "linear"} options={GRADIENT_KINDS} onPick={(v) => onPage({ ...page, gradient: { ...page.gradient!, kind: v === "radial" ? "radial" : undefined } })} />
                <div className="flex items-center gap-2">
                  {page.gradient.via ? (
                    <Colour title="Gradient through" value={page.gradient.via} colours={colours} onDropper={onDropper} onSet={(via, merge) => onPage({ ...page, gradient: { ...page.gradient!, via } }, merge)} />
                  ) : (
                    <span className={cn("flex-1", DIM)}>No middle colour</span>
                  )}
                  {addOrRemove(!!page.gradient.via, "middle colour", () => onPage({ ...page, gradient: { ...page.gradient!, via: "#888888" } }), () => onPage({ ...page, gradient: { ...page.gradient!, via: undefined } }))}
                </div>
              </>
            )}
          </Section>
        </>
      )}

      {box && (
        <>
          <Section title="Position">
            <div className="flex justify-between">
              {ALIGNS.map(([how, label, Icon]) => (
                <Tap key={how} label={label} onClick={() => onAlign(how)}>
                  <Icon className="h-3.5 w-3.5" />
                </Tap>
              ))}
              <Tap label="Space out sideways" disabled={picked.length < 3} onClick={() => onDistribute("x")}>
                <AlignHorizontalSpaceAround className="h-3.5 w-3.5" />
              </Tap>
              <Tap label="Space out down the page" disabled={picked.length < 3} onClick={() => onDistribute("y")}>
                <AlignVerticalSpaceAround className="h-3.5 w-3.5" />
              </Tap>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {num("X", "X", box.x, (n) => (l) => ({ ...l, x: round(l.x + n - box.x) }))}
              {num("Y", "Y", box.y, (n) => (l) => ({ ...l, y: round(l.y + n - box.y) }))}
              {one && num("∠", "Rotation in degrees", one.rotate ?? 0, (n) => (l) => ({ ...l, rotate: n || undefined }), { min: -180, max: 180 })}
            </div>
          </Section>
          <Section title="Layout">
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
              {num("W", "Width", box.w, (n) => sized(n, ratio ? (box.h * n) / box.w : box.h), { min: 1 })}
              {num("H", "Height", box.h, (n) => sized(ratio ? (box.w * n) / box.h : box.w, n), { min: 1 })}
              <Tap label="Keep the shape" on={ratio} onClick={() => setRatio(!ratio)}>
                {ratio ? <Link2 className="h-3.5 w-3.5" /> : <Unlink2 className="h-3.5 w-3.5" />}
              </Tap>
            </div>
          </Section>
          <Section title="Appearance">
            <div className="grid grid-cols-2 gap-2">
              {num(
                "%",
                "Opacity in percent",
                (() => {
                  const o = same((l) => l.opacity ?? 1);
                  return o === null ? null : Math.round(o * 100);
                })(),
                (n) => (l) => ({ ...l, opacity: n >= 100 ? undefined : n / 100 }),
                { min: 0, max: 100 },
              )}
              {every((l) => l.type === "image" || (l.type === "shape" && l.shape === "rect")) &&
                num(
                  "◜",
                  "Corner radius",
                  // corners that differ show as mixed; a number typed here is every corner's
                  (() => {
                    const r = same((l) => (l.type === "image" || l.type === "shape" ? (typeof l.radius === "object" ? -1 : (l.radius ?? 0)) : undefined));
                    return r === -1 ? null : r;
                  })(),
                  (n) => (l) => (l.type === "image" || l.type === "shape" ? { ...l, radius: n || undefined } : l),
                  { min: 0, max: 2000 },
                )}
            </div>
            {every((l) => l.type === "image" || (l.type === "shape" && l.shape === "rect")) && (
              <div className="flex items-center gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-4 gap-1">{split && CORNERS.map(([sign, title], n) => <div key={title}>{num(sign, title, same((l) => cornerOf(l, n)), (v) => setCorner(n, v), { min: 0, max: 2000 })}</div>)}</div>
                <Tap label="Each corner by itself" on={split} onClick={() => setSplit(!split)}>
                  <Scan className="h-3.5 w-3.5" />
                </Tap>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <PickOne
                  label="Blend"
                  value={(() => {
                    const b = same((l) => l.blend ?? "normal");
                    return b === null ? "Mixed" : b === "normal" ? "Normal" : BLEND_NAMES[b];
                  })()}
                  options={[["normal", "Normal"] as const, ...DESIGN_BLENDS.map((b) => [b, BLEND_NAMES[b]] as const)]}
                  onPick={(b) => onPatch((l) => ({ ...l, blend: b === "normal" ? undefined : b }))}
                />
              </div>
              <Tap label="Flip left to right" on={every((l) => !!l.flipX)} onClick={() => onPatch((l) => ({ ...l, flipX: l.flipX ? undefined : true }))}>
                <FlipHorizontal2 className="h-3.5 w-3.5" />
              </Tap>
              <Tap label="Flip top to bottom" on={every((l) => !!l.flipY)} onClick={() => onPatch((l) => ({ ...l, flipY: l.flipY ? undefined : true }))}>
                <FlipVertical2 className="h-3.5 w-3.5" />
              </Tap>
            </div>
            {shape && (
              <PickOne
                label="Shape"
                value={(() => {
                  const s = same((l) => (l.type === "shape" ? l.shape : undefined));
                  return s === null ? "Mixed" : SHAPE_NAMES[s];
                })()}
                options={DESIGN_SHAPES.map((s) => [s, SHAPE_NAMES[s]] as const)}
                onPick={(s) => onPatch((l) => (l.type === "shape" ? { ...l, shape: s } : l))}
              />
            )}
          </Section>
          {(lined || text) && (
            <Section title="Fill" action={addOrRemove(hasGrad, "gradient", () => onPatch(setGrad(GRADIENT)), () => onPatch(setGrad(undefined)))}>
              <div className="flex items-center gap-2">
                {every((l) => l.type === "path" && !l.fill) ? (
                  <>
                    <span className={cn("flex-1", DIM)}>None</span>
                    <Tap label="Add a fill" onClick={() => onPatch((l) => (l.type === "path" ? { ...l, fill: "#d9d9d9" } : l))}>
                      <Plus className="h-3.5 w-3.5" />
                    </Tap>
                  </>
                ) : (
                  colour("Fill", same((l) => (l.type === "shape" || l.type === "path" ? l.fill : l.type === "text" ? l.color : undefined)), (c) => (l) => (l.type === "shape" || l.type === "path" ? { ...l, fill: c } : l.type === "text" ? { ...l, color: c } : l))
                )}
                {/* a path may be a line alone */}
                {picked.some((l) => l.type === "path" && l.fill) && (
                  <Tap label="No fill" onClick={() => onPatch((l) => (l.type === "path" ? { ...l, fill: undefined, gradient: undefined, stroke: l.stroke ?? { color: "#111111", width: 6 } } : l))}>
                    <Ban className="h-3.5 w-3.5" />
                  </Tap>
                )}
              </div>
              {hasGrad && (
                <div className="grid grid-cols-[1fr_4.5rem] gap-2">
                  {colour("Gradient to", same((l) => gradOf(l)?.to), (c) => setGrad({ to: c }))}
                  {num("∠", "Gradient angle in degrees", same((l) => gradOf(l)?.angle), (n) => setGrad({ angle: n }), { min: -360, max: 360 })}
                </div>
              )}
              {hasGrad && (
                <>
                  <Choice label="Gradient kind" value={same((l) => (gradOf(l) ? (gradOf(l)!.kind ?? "linear") : undefined))} options={GRADIENT_KINDS} onPick={(v) => onPatch(setGrad({ kind: v === "radial" ? "radial" : undefined }))} />
                  <div className="flex items-center gap-2">
                    {picked.some((l) => gradOf(l)?.via) ? colour("Gradient through", same((l) => gradOf(l)?.via), (c) => setGrad({ via: c })) : <span className={cn("flex-1", DIM)}>No middle colour</span>}
                    {addOrRemove(picked.some((l) => gradOf(l)?.via), "middle colour", () => onPatch(setGrad({ via: "#888888" })), () => onPatch(setGrad({ via: undefined })))}
                  </div>
                </>
              )}
            </Section>
          )}
          {(lined || text) && (
            <Section
              title="Stroke"
              action={addOrRemove(hasLine, "stroke", () => onPatch(setLine({ color: "#000000", width: 4 })), () => onPatch(setLine(undefined)))}
            >
              {hasLine && (
                <div className="grid grid-cols-[1fr_4.5rem] gap-2">
                  {colour("Stroke", same((l) => lineOf(l)?.color), (c) => (l) => setLine({ width: lineOf(l)?.width ?? 4, color: c })(l))}
                  {num("≡", "Stroke width", same((l) => lineOf(l)?.width), (n) => (l) => setLine(n > 0 ? { color: lineOf(l)?.color ?? "#000000", width: n } : undefined)(l), { min: 0, max: lined ? 200 : 60 })}
                </div>
              )}
              {lined && hasLine && (
                <>
                  <Choice
                    label="The side of the edge the line lies on"
                    value={same((l) => (strokeOf(l) ? (strokeOf(l)!.side ?? "center") : undefined))}
                    options={[["center", "Centre"], ["inside", "Inside"], ["outside", "Outside"]] as const}
                    onPick={(v) => onPatch(setStroke({ side: v === "center" ? undefined : v }))}
                  />
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    {/* a dash with no gap is no dash: a dash typed first gets a gap as long as itself */}
                    {num("┄", "Dash length", same((l) => (strokeOf(l) ? (strokeOf(l)!.dash?.[0] ?? 0) : undefined)), (n) => (l) => setDash(n, strokeOf(l)?.dash?.[1] || n)(l), { min: 0, max: 2000 })}
                    {num("⋯", "Gap between dashes", same((l) => (strokeOf(l) ? (strokeOf(l)!.dash?.[1] ?? 0) : undefined)), (n) => (l) => setDash(strokeOf(l)?.dash?.[0] ?? n, n)(l), { min: 0, max: 2000 })}
                    <Tap label="Round ends" on={every((l) => !!strokeOf(l)?.round)} onClick={() => onPatch((l) => setStroke({ round: strokeOf(l)?.round ? undefined : true })(l))}>
                      <CircleDot className="h-3.5 w-3.5" />
                    </Tap>
                  </div>
                </>
              )}
            </Section>
          )}
          {text && (
            <Section title="Typography">
              <DropdownMenu>
                <DropdownMenuTrigger aria-label="Font" className={cn(FIELD, "w-full justify-between outline-none")}>
                  <span className="truncate">{DESIGN_FONTS.find((f) => f.family === same((l) => (l.type === "text" ? l.font : undefined)))?.label ?? "Mixed"}</span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-96 w-56 overflow-y-auto">
                  {DESIGN_FONTS.map((f) => (
                    <DropdownMenuItem key={f.family} onSelect={() => onPatch((l) => (l.type === "text" ? { ...l, font: f.family } : l))} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[15px] leading-6" style={{ fontFamily: `"${f.family}"`, fontWeight: designWeight(f.family) }}>
                        {f.label}
                      </span>
                      {same((l) => (l.type === "text" ? l.font : undefined)) === f.family && <Check className="h-3.5 w-3.5 shrink-0" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="grid grid-cols-3 gap-2">
                {num("Aa", "Font size", same((l) => (l.type === "text" ? l.size : undefined)), (n) => (l) => (l.type === "text" ? { ...l, size: n } : l), { min: 8, max: 600 })}
                {num("↕", "Line height, as a multiple of the size", same((l) => (l.type === "text" ? (l.lineHeight ?? 1.15) : undefined)), (n) => (l) => (l.type === "text" ? { ...l, lineHeight: n } : l), { min: 0.8, max: 3, step: 0.05 })}
                {num("↔", "Letter spacing in pixels", same((l) => (l.type === "text" ? (l.spacing ?? 0) : undefined)), (n) => (l) => (l.type === "text" ? { ...l, spacing: n || undefined } : l), { min: -20, max: 200 })}
              </div>
              <Choice
                label="How the words fit their box"
                value={same((l) => (l.type === "text" ? (l.fit ?? "fixed") : undefined))}
                options={[["fixed", "Fixed size"], ["shrink", "Shrink to fit"]] as const}
                onPick={(v) => onPatch((l) => (l.type === "text" ? { ...l, fit: v === "shrink" ? "shrink" : undefined } : l))}
              />
              <div className="flex justify-between">
                {(
                  [
                    ["left", "Text align left", AlignLeft],
                    ["center", "Text align centre", AlignCenter],
                    ["right", "Text align right", AlignRight],
                  ] as const
                ).map(([v, label, Icon]) => (
                  <Tap key={v} label={label} on={same((l) => (l.type === "text" ? l.align : undefined)) === v} onClick={() => onPatch((l) => (l.type === "text" ? { ...l, align: v } : l))}>
                    <Icon className="h-3.5 w-3.5" />
                  </Tap>
                ))}
                {(
                  [
                    ["top", "Align to the top of the box", AlignVerticalJustifyStart],
                    ["middle", "Align to the middle of the box", AlignVerticalJustifyCenter],
                    ["bottom", "Align to the bottom of the box", AlignVerticalJustifyEnd],
                  ] as const
                ).map(([v, label, Icon]) => (
                  <Tap key={v} label={label} on={same((l) => (l.type === "text" ? (l.valign ?? "top") : undefined)) === v} onClick={() => onPatch((l) => (l.type === "text" ? { ...l, valign: v === "top" ? undefined : v } : l))}>
                    <Icon className="h-3.5 w-3.5" />
                  </Tap>
                ))}
                <Tap label="Even out the lines" on={same((l) => (l.type === "text" ? !!l.balance : undefined)) === true} onClick={() => onPatch((l) => (l.type === "text" ? { ...l, balance: l.balance ? undefined : true } : l))}>
                  <WrapText className="h-3.5 w-3.5" />
                </Tap>
                <Tap label="Capitals" on={same((l) => (l.type === "text" ? !!l.upper : undefined)) === true} onClick={() => onPatch((l) => (l.type === "text" ? { ...l, upper: l.upper ? undefined : true } : l))}>
                  <CaseUpper className="h-3.5 w-3.5" />
                </Tap>
              </div>
            </Section>
          )}
          <Section
            title="Effects"
            action={addOrRemove(picked.some((l) => l.shadow), "shadow", () => onPatch((l) => ({ ...l, shadow: SHADOW })), () => onPatch((l) => ({ ...l, shadow: undefined })))}
          >
            {picked.some((l) => l.shadow) && (
              <>
                <div className="grid grid-cols-[1fr_4.5rem] gap-2">
                  {colour("Shadow", same((l) => l.shadow?.color), (c) => (l) => ({ ...l, shadow: { ...(l.shadow ?? SHADOW), color: c } }))}
                  {num("%", "Shadow strength in percent", (() => {
                    const o = same((l) => l.shadow?.opacity);
                    return o === null ? null : Math.round(o * 100);
                  })(), (n) => (l) => ({ ...l, shadow: { ...(l.shadow ?? SHADOW), opacity: n / 100 } }), { min: 0, max: 100 })}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {num("X", "Shadow X", same((l) => l.shadow?.x), (n) => (l) => ({ ...l, shadow: { ...(l.shadow ?? SHADOW), x: n } }), { min: -1000, max: 1000 })}
                  {num("Y", "Shadow Y", same((l) => l.shadow?.y), (n) => (l) => ({ ...l, shadow: { ...(l.shadow ?? SHADOW), y: n } }), { min: -1000, max: 1000 })}
                  {num("◌", "Shadow blur", same((l) => l.shadow?.blur), (n) => (l) => ({ ...l, shadow: { ...(l.shadow ?? SHADOW), blur: n } }), { min: 0, max: 400 })}
                </div>
              </>
            )}
          </Section>
          {image && (
            <Section
              title="Picture"
              action={
                one && (
                  <Tap label="Move the picture inside its box" on={cropping} onClick={() => onCrop(!cropping)}>
                    <Crop className="h-3.5 w-3.5" />
                  </Tap>
                )
              }
            >
              <Choice label="How the picture sits in its box" value={same((l) => (l.type === "image" ? l.fit : undefined))} options={[["cover", "Fill"], ["contain", "Fit"]] as const} onPick={(fit) => onPatch((l) => (l.type === "image" ? { ...l, fit } : l))} />
              <div className="grid grid-cols-3 gap-2">
                {num("⊕", "Zoom in percent", (() => {
                  const z = same((l) => (l.type === "image" ? (l.zoom ?? 1) : undefined));
                  return z === null ? null : Math.round(z * 100);
                })(), (n) => (l) => (l.type === "image" ? { ...l, zoom: n > 100 ? n / 100 : undefined } : l), { min: 100, max: 800 })}
                {(["x", "y"] as const).map((axis) => (
                  <div key={axis}>
                    {num(axis === "x" ? "↔" : "↕", axis === "x" ? "Which part stays in view, left to right, in percent" : "Which part stays in view, top to bottom, in percent", (() => {
                      const f = same((l) => (l.type === "image" ? (l.focus?.[axis] ?? 0.5) : undefined));
                      return f === null ? null : Math.round(f * 100);
                    })(), (n) => (l) => (l.type === "image" ? { ...l, focus: { x: 0.5, y: 0.5, ...l.focus, [axis]: n / 100 } } : l), { min: 0, max: 100 })}
                  </div>
                ))}
              </div>
              {one?.type === "image" &&
                (one.uncut ? (
                  <button type="button" onClick={() => onPatch((l) => (l.type === "image" && l.uncut ? { ...l, picture: l.uncut, uncut: undefined } : l))} className="flex h-7 items-center justify-center rounded-[5px] border border-[#e6e6e6] hover:bg-zinc-500/10 dark:border-[#4d4d4d]">
                    Put the background back
                  </button>
                ) : (
                  <button type="button" disabled={cutting} onClick={onCutOut} className="flex h-7 items-center justify-center rounded-[5px] border border-[#e6e6e6] hover:bg-zinc-500/10 disabled:opacity-50 dark:border-[#4d4d4d]">
                    {cutting ? "Cutting it out" : "Remove background"}
                  </button>
                ))}
            </Section>
          )}
          {image && (
            <Section
              title="Adjust"
              action={
                picked.some((l) => l.type === "image" && (l.adjust || l.duotone || l.vignette || l.grain || l.blur)) && (
                  <Tap label="Put the picture's colours back as they were" onClick={() => onPatch((l) => (l.type === "image" ? { ...l, adjust: undefined, duotone: undefined, vignette: undefined, grain: undefined, blur: undefined } : l))}>
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Tap>
                )
              }
            >
              {DESIGN_ADJUST.map((k) =>
                slide(ADJUST_NAMES[k], same((l) => (l.type === "image" ? (l.adjust?.[k] ?? 0) : undefined)), (n) => (l) => (l.type === "image" ? { ...l, adjust: { ...l.adjust, [k]: n || undefined } } : l), -100, 100),
              )}
              {slide("Vignette", same((l) => (l.type === "image" ? (l.vignette ?? 0) : undefined)), (n) => (l) => (l.type === "image" ? { ...l, vignette: n || undefined } : l), -100, 100)}
              {slide("Grain", same((l) => (l.type === "image" ? (l.grain ?? 0) : undefined)), (n) => (l) => (l.type === "image" ? { ...l, grain: n || undefined } : l), 0, 100)}
              {slide("Blur", same((l) => (l.type === "image" ? (l.blur ?? 0) : undefined)), (n) => (l) => (l.type === "image" ? { ...l, blur: n || undefined } : l), 0, 100)}
              <Choice
                label="The picture's colours"
                value={picked.every((l) => l.type === "image" && l.duotone) ? "two" : "own"}
                options={[["own", "Its own colours"], ["two", "Two colours"]] as const}
                onPick={(v) => onPatch((l) => (l.type === "image" ? { ...l, duotone: v === "two" ? (l.duotone ?? { dark: "#000000", light: "#ffffff" }) : undefined } : l))}
              />
              {picked.every((l) => l.type === "image" && l.duotone) && (
                <div className="grid grid-cols-2 gap-2">
                  {colour("Its darks", same((l) => (l.type === "image" ? l.duotone?.dark : undefined)), (c) => (l) => (l.type === "image" && l.duotone ? { ...l, duotone: { ...l.duotone, dark: c } } : l))}
                  {colour("Its lights", same((l) => (l.type === "image" ? l.duotone?.light : undefined)), (c) => (l) => (l.type === "image" && l.duotone ? { ...l, duotone: { ...l.duotone, light: c } } : l))}
                </div>
              )}
            </Section>
          )}
        </>
      )}

      <Section title="Export">
        <div className="grid grid-cols-2 gap-2">
          <Choice label="File type" value={as.jpeg ? "jpeg" : "png"} options={[["png", "PNG"], ["jpeg", "JPG"]] as const} onPick={(t) => setAs({ ...as, jpeg: t === "jpeg" })} />
          <Choice label="Size" value={as.scale} options={[[1, "1×"], [2, "2×"]] as const} onPick={(scale) => setAs({ ...as, scale })} />
        </div>
        <button type="button" onClick={() => onExport(framesPicked.length > 1 ? framesPicked : at, as)} className="flex h-7 items-center justify-center rounded-[5px] border border-[#e6e6e6] hover:bg-zinc-500/10 dark:border-[#4d4d4d]">
          {framesPicked.length > 1 ? `Export the ${framesPicked.length} picked frames` : `Export ${pageName(page, at)}`}
        </button>
        {count > 1 && (
          <button type="button" onClick={() => onExport(undefined, as)} className="flex h-7 items-center justify-center rounded-[5px] border border-[#e6e6e6] hover:bg-zinc-500/10 dark:border-[#4d4d4d]">
            Export all {count} frames
          </button>
        )}
      </Section>
    </aside>
  );
}
