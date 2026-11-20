import { useEffect, useRef, useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
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
  Check,
  ChevronDown,
  Crop,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Strikethrough,
  Underline,
  GripVertical,
  Group,
  Link2,
  Minus,
  Plus,
  RotateCcw,
  Scan,
  SlidersHorizontal,
  Ungroup,
  Unlink2,
  WrapText,
  X,
  LayoutGrid,
} from "lucide-react";
import { CtMark } from "@/components/CtMark";
import type { Design, DesignPage, Effect, GradientStop, Layer, Paint, PaintLook, Pin, Stroke } from "@contracts/design";
import { DESIGN_ADJUST, DESIGN_BLENDS, DESIGN_EFFECTS, DESIGN_FORMATS, DESIGN_GRADIENTS, DESIGN_HEADS, DESIGN_LIMITS, DESIGN_PICTURE_MODES, DESIGN_SHAPES, EFFECT_PRESETS, EFFECTS_MAX } from "@contracts/design";
import { effectsOf, withEffects } from "@/lib/design/effects";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { alphaOf, typedHex, withAlpha } from "@/lib/design/colour";
import { colourAt, fillsOf, moved, strokesOf, takesFills, takesStrokes, withFills, withStrokes } from "@/lib/design/paint";
import { pictureUrl } from "@/lib/designs";
import { boundsOf, frameOf, groupName, pageName, resizeAll, SHAPE_NAMES, type Align } from "@/lib/design/hands";
import { DESIGN_FONTS, designWeight, faceOf, WEIGHT_NAMES, weightsOf } from "@/lib/design/fonts";
import { caseOf } from "@/lib/design/runs";
import { addOwnFont, removeOwnFont, useOwnFonts } from "@/lib/design/own-fonts";
import { confirmDialog } from "@/lib/dialogs";
import { useZoom, type ViewStore } from "@/lib/design/view";
import { scrubBy } from "@/lib/design/feel";
import { resized } from "@/lib/design/resize";
import { CopySizes } from "./CopySizes";
import { CHECKS, ColourPicker } from "./ColourPicker";
import { FrameAids } from "./FrameAids";
import { setAidPref, useAidPrefs } from "@/lib/design/aids";
import { Tip } from "./Tip";
import { cn } from "@/lib/utils";

/**
 * The properties of what is picked: where it is, its size, how it looks, its fill and line, its type. No layer picked:
 * the frame's own (its name, its place on the canvas, its size, its colour). A number is typed (Enter or leaving the field sets it, the arrows step it, Shift by ten) or dragged
 * by its label (half a step a pixel; Shift ten times that, Alt a tenth); while it is dragged the canvas shows it, and it is one step to undo when let go. A choice made in a
 * menu here gives the keys back to the canvas at once: ⌘Z right after picking a font undoes the font.
 */

const FIELD = "flex h-6 min-w-0 items-center gap-1.5 rounded-[5px] border border-transparent bg-[#f5f5f5] px-1.5 focus-within:border-[#0d99ff] hover:border-[#e6e6e6] focus-within:hover:border-[#0d99ff] dark:bg-[#383838] dark:hover:border-[#4d4d4d]";
const DIM = "text-zinc-500 dark:text-[#b3b3b3]";
const round = (n: number) => Math.round(n * 100) / 100;

function Num({ label, title, value, onLive, onCommit, min = -Infinity, max = Infinity, step = 1, rate = 0.5 }: { label: ReactNode; title: string; value: number | null; onLive?: (n: number | null) => void; onCommit: (n: number) => void; min?: number; max?: number; step?: number; /** steps a pixel dragged on the label */ rate?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const dropped = useRef(false);
  const fit = (n: number) => round(Math.min(max, Math.max(min, n)));
  const set = (text: string) => {
    const n = Number(text.replace(",", "."));
    if (text.trim() !== "" && Number.isFinite(n) && fit(n) !== value) onCommit(fit(n));
  };
  /** The label is a handle: dragged sideways it steps the number, `rate` steps a pixel; the keys held are read at every move. */
  const scrub = (e: React.PointerEvent) => {
    if (value === null) return;
    e.preventDefault();
    let x = e.clientX;
    let sum = 0;
    let last = value;
    const move = (ev: PointerEvent) => {
      sum += scrubBy(ev.clientX - x, rate, { shift: ev.shiftKey, alt: ev.altKey });
      x = ev.clientX;
      // in whole steps, or tenths of one with Alt
      const q = ev.altKey ? 0.1 : 1;
      last = fit(value + Math.round(sum / q) * q * step);
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
function Colour({ title, value, colours, onSet, onDropper, alpha = false }: { title: string; value: string | null; colours: readonly string[]; onSet: (c: string, merge?: string) => void; onDropper?: (take: (hex: string) => void) => void; alpha?: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // each opening is a picking of its own: its drags never join the last opening's
  const opened = useRef(0);
  const hex = value && (alpha ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/i : /^#[0-9a-f]{6}$/i).test(value) ? value : "#000000";
  return (
    <div className={cn(FIELD, "flex-1")}>
      <Popover open={open} onOpenChange={(now) => (now && opened.current++, setOpen(now))}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={title}
            className="h-4 w-4 shrink-0 rounded-sm border border-black/15 dark:border-white/20"
            style={{ background: value === null ? "repeating-linear-gradient(45deg, #888 0 3px, #bbb 3px 6px)" : `linear-gradient(${hex}, ${hex}), ${CHECKS}` }}
          />
        </PopoverTrigger>
        <PopoverContent side="left" align="start" sideOffset={14} className="w-auto border-[#e6e6e6] bg-white p-3 text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]">
          <ColourPicker
            alpha={alpha}
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
        value={draft ?? (value === null ? "" : value.slice(1, 7).toUpperCase())}
        placeholder={value === null ? "Mixed" : undefined}
        maxLength={alpha ? 9 : 7}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())}
        onBlur={(e) => {
          const read = typedHex(e.currentTarget.value);
          // six digits keep how solid the colour was; eight say it
          const typed = read && (!alpha ? read.slice(0, 7) : read.length === 7 ? withAlpha(read, alphaOf(hex)) : read);
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
const AID_ITEMS = [["rulers", "Rulers", "⇧R"], ["grids", "Layout grids", typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌃G" : "Ctrl+Shift+4"], ["pixels", "Pixel grid", "⇧'"]] as const;

export function ZoomMenu({ view, onZoom }: { view: ViewStore; onZoom: (to: "in" | "out" | "fit" | "selection" | number) => void }) {
  const aids = useAidPrefs();
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
        <DropdownMenuSeparator />
        {AID_ITEMS.map(([k, name, keys]) => (
          <DropdownMenuItem key={k} onSelect={() => setAidPref(k)} className="gap-2">
            <Check className={cn("h-3.5 w-3.5", !aids[k] && "invisible")} />
            {name}
            <DropdownMenuShortcut>{keys}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
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

const PINS = {
  x: [["left", "Left"], ["right", "Right"], ["both", "Both"], ["center", "Centre"], ["scale", "Scale"]],
  y: [["top", "Top"], ["bottom", "Bottom"], ["both", "Both"], ["center", "Centre"], ["scale", "Scale"]],
} as const;

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
  onTidy,
  view,
  onZoom,
  framesPicked,
  onExport,
  cropping,
  onCrop,
  onCutOut,
  onSplit,
  cutting,
  onGroup,
  onUngroup,
  colours,
  onDropper,
  onCopySize,
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
  /** the picked layers or frames tidied up (a row, a column or a grid evened out); none when they are not one */
  onTidy?: () => void;
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
  /** the picked picture split into its words, its pieces and what is behind them (a Mac of the person's own does it) */
  onSplit: () => void;
  cutting: boolean;
  /** the picked layers made one group, and the groups they are in taken apart */
  onGroup: () => void;
  onUngroup: () => void;
  /** the colours the design already uses, for the picker */
  colours: readonly string[];
  /** the next press on the canvas gives its colour to `take` */
  onDropper: (take: (hex: string) => void) => void;
  /** a copy of the frame in another size, its layers placed by their pins */
  onCopySize: (size: { w: number; h: number; name: string }) => void;
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
  const num = (label: ReactNode, title: string, value: number | null, to: (n: number) => (l: Layer) => Layer, more: { min?: number; max?: number; step?: number; rate?: number } = {}) => (
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
  /** The font every picked text is set in (null: they differ), and the person's own fonts beside the app's. */
  const fontNow = same((l) => (l.type === "text" ? l.font : undefined));
  const ownFonts = useOwnFonts();
  const fontFile = useRef<HTMLInputElement>(null);
  const [fontSaid, setFontSaid] = useState("");
  const shape = every((l) => l.type === "shape");
  const image = every((l) => l.type === "image");
  /** The fills or lines every picked layer has, when they are the same list (null: they differ). */
  const sameList = <T,>(of: (l: Layer) => T[]): T[] | null => {
    const first = picked[0] ? JSON.stringify(of(picked[0])) : "";
    return picked[0] && picked.every((l) => JSON.stringify(of(l)) === first) ? of(picked[0]) : null;
  };
  /** A corner's radius of a picture or a rectangle (0: top left, then round the box), and that corner set. */
  const cornerOf = (l: Layer, n: number): number | undefined => (l.type === "image" || l.type === "shape" ? (typeof l.radius === "object" ? l.radius[n]! : (l.radius ?? 0)) : undefined);
  const setCorner = (n: number, v: number) => (l: Layer): Layer => {
    if (l.type !== "image" && l.type !== "shape") return l;
    const r = [0, 1, 2, 3].map((k) => (k === n ? v : (cornerOf(l, k) ?? 0))) as [number, number, number, number];
    return { ...l, radius: r.every((x) => x === r[0]) ? r[0] || undefined : r };
  };
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
  const frame = frameOf(page, at, design.width, design.height);
  /** A number field of the frame itself. */
  const fnum = (label: string, title: string, value: number, set: (n: number) => Partial<DesignPage>, more: { min: number; max: number }) => (
    <Num label={label} title={title} value={value} {...more} onLive={(n) => onPagePreview(n === null ? null : { ...page, ...set(n) })} onCommit={(n) => onPage({ ...page, ...set(n) })} />
  );
  /** The align and space-out buttons, for `count` picked layers or frames. */
  const lineUp = (count: number) => (
    <div className="flex justify-between">
      {ALIGNS.map(([how, label, Icon]) => (
        <Tap key={how} label={label} onClick={() => onAlign(how)}>
          <Icon className="h-3.5 w-3.5" />
        </Tap>
      ))}
      <Tap label="Space out sideways" disabled={count < 3} onClick={() => onDistribute("x")}>
        <AlignHorizontalSpaceAround className="h-3.5 w-3.5" />
      </Tap>
      <Tap label="Space out down the page" disabled={count < 3} onClick={() => onDistribute("y")}>
        <AlignVerticalSpaceAround className="h-3.5 w-3.5" />
      </Tap>
    </div>
  );
  const tidyTap = (
    <Tap label="Tidy up" disabled={!onTidy} onClick={() => onTidy?.()}>
      <LayoutGrid className="h-3.5 w-3.5" />
    </Tap>
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

      {/* several frames picked: lined up, spaced out and tidied like layers */}
      {!box && framesPicked.length > 1 && (
        <Section title="Position" action={tidyTap}>
          {lineUp(framesPicked.length)}
        </Section>
      )}

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
              {fnum("W", "Width", frame.w, (n) => resized(page, { w: n, h: frame.h }), big)}
              {fnum("H", "Height", frame.h, (n) => resized(page, { w: frame.w, h: n }), big)}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Frame size" className={cn(FIELD, "w-full justify-between outline-none")}>
                <span className="truncate">{DESIGN_FORMATS.find((f) => f.w === frame.w && f.h === frame.h)?.name ?? "Custom size"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {DESIGN_FORMATS.map((f) => (
                  <DropdownMenuItem key={f.id} onSelect={() => onPage(resized(page, { w: f.w, h: f.h }))} className="flex justify-between gap-4">
                    {f.name}
                    <span className={DIM}>
                      {f.w} × {f.h}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* off: what lies past the frame's edges shows on the canvas too; the PNG is always the frame alone */}
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={page.clip !== false} onCheckedChange={(on) => onPage({ ...page, clip: on === true ? undefined : false })} />
              Clip content
            </label>
            {!page.loose && (
              <DropdownMenu>
                <DropdownMenuTrigger className="flex h-7 items-center justify-center gap-1 rounded-[5px] border border-[#e6e6e6] outline-none hover:bg-zinc-500/10 dark:border-[#4d4d4d]">
                  Copy in another size
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60">
                  <CopySizes Item={DropdownMenuItem} from={frame} onCopy={onCopySize} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </Section>
          <FillList fills={fillsOf(page)} design={design} colours={colours} onDropper={onDropper} base="#ffffff" onSet={(f, merge) => onPage(withFills(page, f), merge)} onLive={(f) => onPagePreview(f ? withFills(page, f) : null)} />
          <StrokeList strokes={strokesOf(page)} colours={colours} onDropper={onDropper} max={200} box inside onSet={(st, merge) => onPage(withStrokes(page, st), merge)} onLive={(st) => onPagePreview(st ? withStrokes(page, st) : null)} />
          <Section title="Finish">
            <Slide label="Grain" value={page.grain ?? 0} min={0} max={100} onLive={(n) => onPagePreview(n === null ? null : { ...page, grain: n || undefined })} onCommit={(n) => onPage({ ...page, grain: n || undefined })} />
            <Slide label="Vignette" value={page.vignette ?? 0} min={-100} max={100} onLive={(n) => onPagePreview(n === null ? null : { ...page, vignette: n || undefined })} onCommit={(n) => onPage({ ...page, vignette: n || undefined })} />
          </Section>
          {!page.loose && <FrameAids page={page} onPage={onPage} colours={colours} onDropper={onDropper} />}
        </>
      )}

      {box && (
        <>
          <Section title="Position" action={tidyTap}>
            {lineUp(picked.length)}
            <div className="grid grid-cols-2 gap-2">
              {/* a loose picture's place is on the canvas: its own box only follows it */}
              {num("X", "X", box.x + (page.loose ? (page.x ?? 0) : 0), (n) => (l) => ({ ...l, x: round(l.x + n - box.x - (page.loose ? (page.x ?? 0) : 0)) }))}
              {num("Y", "Y", box.y + (page.loose ? (page.y ?? 0) : 0), (n) => (l) => ({ ...l, y: round(l.y + n - box.y - (page.loose ? (page.y ?? 0) : 0)) }))}
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
          {/* how the picked layers follow the frame's edges when it changes size; the pressed one again takes the pin off */}
          {!page.loose && (
            <Section title="Pin to the frame">
              {(["x", "y"] as const).map((axis) => {
                const now = same((l) => l.pin?.[axis]);
                const set = (v: string) => (l: Layer): Layer => {
                  const pin: Pin = { ...l.pin, [axis]: now === v ? undefined : v };
                  return { ...l, pin: pin.x || pin.y ? pin : undefined };
                };
                return <Choice key={axis} label={axis === "x" ? "Pinned side to side" : "Pinned up and down"} value={now} options={PINS[axis]} onPick={(v) => onPatch(set(v))} />;
              })}
            </Section>
          )}
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
                { min: 0, max: 100, rate: 0.4 },
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
                <Tap label="Each corner separately" on={split} onClick={() => setSplit(!split)}>
                  <Scan className="h-3.5 w-3.5" />
                </Tap>
              </div>
            )}
            {every((l) => l.type === "image" || (l.type === "shape" && l.shape === "rect")) &&
              slide("Corner smoothing", same((l) => (l.type === "image" || l.type === "shape" ? Math.round((l.smooth ?? 0) * 100) : undefined)), (n) => (l) => (l.type === "image" || l.type === "shape" ? { ...l, smooth: n ? n / 100 : undefined } : l), 0, 100)}
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
          {every(takesFills) && (
            <FillList fills={sameList(fillsOf)} design={design} colours={colours} onDropper={onDropper} base="#d9d9d9" onSet={(f, merge) => onPatch((l) => withFills(l, f), merge)} onLive={(f) => onPreview(f ? (l) => withFills(l, f) : null)} />
          )}
          {every(takesStrokes) && (
            <StrokeList
              strokes={sameList(strokesOf)}
              colours={colours}
              onDropper={onDropper}
              max={text ? 60 : 200}
              text={text}
              box={every((l) => l.type === "image" || (l.type === "shape" && l.shape === "rect"))}
              open={every((l) => l.type === "path" && !l.closed)}
              onSet={(st, merge) => onPatch((l) => withStrokes(l, st), merge)}
              onLive={(st) => onPreview(st ? (l) => withStrokes(l, st) : null)}
            />
          )}
          {text && (
            <Section title="Typography">
              <DropdownMenu>
                <DropdownMenuTrigger aria-label="Font" className={cn(FIELD, "w-full justify-between outline-none")}>
                  {/* one of the person's own (or one they took away since) is shown by its own name */}
                  <span className="truncate">{DESIGN_FONTS.find((f) => f.family === fontNow)?.label ?? fontNow ?? "Mixed"}</span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-96 w-56 overflow-y-auto">
                  {DESIGN_FONTS.map((f) => (
                    <DropdownMenuItem key={f.family} onSelect={() => onPatch((l) => (l.type === "text" ? { ...l, font: f.family, weight: undefined } : l))} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[15px] leading-6" style={{ fontFamily: `"${f.family}"`, fontWeight: designWeight(f.family) }}>
                        {f.label}
                      </span>
                      {fontNow === f.family && <Check className="h-3.5 w-3.5 shrink-0" />}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  {ownFonts.map((f) => (
                    <DropdownMenuItem key={f.id} data-own-font={f.family} onSelect={() => onPatch((l) => (l.type === "text" ? { ...l, font: f.family, weight: undefined } : l))} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[15px] leading-6" style={{ fontFamily: `"${f.family}", "Inter"`, fontWeight: 400 }}>
                        {f.family}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {fontNow === f.family && <Check className="h-3.5 w-3.5" />}
                        <span
                          role="button"
                          aria-label={`Remove ${f.family}`}
                          className={cn("flex h-5 w-5 items-center justify-center rounded-[4px] hover:bg-zinc-500/20", DIM)}
                          onClick={(e) => {
                            // the row itself picks the font: this takes it away
                            e.preventDefault();
                            e.stopPropagation();
                            void confirmDialog({ title: `Remove ${f.family} from your fonts?`, body: "Texts set in it keep its name and are drawn in the default font until it is added again.", ok: "Remove", danger: true }).then(
                              (yes) => void (yes && removeOwnFont(f.id).then(() => setFontSaid(""), (err: unknown) => setFontSaid(err instanceof Error ? err.message : String(err)))),
                            );
                          }}
                        >
                          <X className="h-3 w-3" />
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onSelect={() => fontFile.current?.click()}>Add a font…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* a font file from this computer (.ttf, .otf, or a collection): every face in it becomes one of the person's fonts */}
              <input
                ref={fontFile}
                type="file"
                accept=".ttf,.otf,.ttc,font/ttf,font/otf,font/collection"
                multiple
                aria-label="Add a font file"
                className="hidden"
                onChange={(e) => {
                  const files = [...(e.currentTarget.files ?? [])];
                  e.currentTarget.value = "";
                  void (async () => {
                    const said: string[] = [];
                    const added: string[] = [];
                    for (const file of files) {
                      try {
                        const out = await addOwnFont(file);
                        added.push(...out.added.map((f) => f.family));
                        said.push(...out.notes);
                      } catch (err) {
                        said.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }
                    // several faces at once (a collection holds a family): said by name, and the picked words stay as they are
                    if (added.length > 1) said.unshift(`Added ${added.join(", ")}`);
                    setFontSaid(said.join(". "));
                    // one face added: the picked words are set in it at once
                    if (added.length === 1) onPatch((l) => (l.type === "text" ? { ...l, font: added[0]! } : l));
                  })();
                }}
              />
              {fontSaid && <p className={cn("text-[11px] leading-4", DIM)}>{fontSaid}</p>}
              {/* the weights the font's family has a face for, and the slant and lines over the letters */}
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  {(() => {
                    const weight = same((l) => (l.type === "text" ? faceOf(l.font, l.weight, l.italic).weight : undefined));
                    return (
                      <PickOne
                        label="Weight"
                        value={weight === null ? "Mixed" : (WEIGHT_NAMES[weight] ?? String(weight))}
                        options={(fontNow ? weightsOf(fontNow) : []).map((w) => [String(w), WEIGHT_NAMES[w] ?? String(w)] as const)}
                        onPick={(v) => onPatch((l) => (l.type === "text" ? { ...l, weight: Number(v) } : l))}
                      />
                    );
                  })()}
                </div>
                {(
                  [
                    ["italic", "Italic", Italic],
                    ["underline", "Underline", Underline],
                    ["strike", "Strikethrough", Strikethrough],
                  ] as const
                ).map(([k, label, Icon]) => (
                  <Tap key={k} label={label} on={same((l) => (l.type === "text" ? !!l[k] : undefined)) === true} onClick={() => onPatch((l) => (l.type === "text" ? ({ ...l, [k]: l[k] ? undefined : true } as Layer) : l))}>
                    <Icon className="h-3.5 w-3.5" />
                  </Tap>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {num("Aa", "Font size", same((l) => (l.type === "text" ? l.size : undefined)), (n) => (l) => (l.type === "text" ? { ...l, size: n } : l), { min: 8, max: 600 })}
                {num("↕", "Line height, as a multiple of the size", same((l) => (l.type === "text" ? (l.lineHeight ?? 1.15) : undefined)), (n) => (l) => (l.type === "text" ? { ...l, lineHeight: n } : l), { min: 0.8, max: 3, step: 0.05 })}
                {num("↔", "Letter spacing in pixels", same((l) => (l.type === "text" ? (l.spacing ?? 0) : undefined)), (n) => (l) => (l.type === "text" ? { ...l, spacing: n || undefined } : l), { min: -20, max: 200 })}
              </div>
              <Choice
                label="Text fit"
                value={same((l) => (l.type === "text" ? (l.lines ? "lines" : (l.fit ?? "fixed")) : undefined))}
                options={[["fixed", "Fixed size"], ["shrink", "Shrink to fit"], ["lines", "Lines"]] as const}
                onPick={(v) => onPatch((l) => (l.type === "text" ? { ...l, fit: v === "shrink" ? "shrink" : undefined, lines: v === "lines" ? (l.lines ?? 2) : undefined } : l))}
              />
              {same((l) => (l.type === "text" ? !!l.lines : undefined)) === true && num("≡", "At most this many lines, with no word alone on the last one", same((l) => (l.type === "text" ? (l.lines ?? 2) : undefined)), (n) => (l) => (l.type === "text" ? { ...l, lines: n } : l), { min: 1, max: 12 })}
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
              </div>
              {(() => {
                const CASES = [["typed", "As typed"], ["upper", "Upper case"], ["lower", "Lower case"], ["title", "Title case"], ["small", "Small capitals"]] as const;
                const now = same((l) => (l.type === "text" ? (caseOf(l) ?? "typed") : undefined));
                return (
                  <PickOne
                    label="Case"
                    value={CASES.find(([v]) => v === now)?.[1] ?? "Mixed"}
                    options={CASES}
                    onPick={(v) => onPatch((l) => (l.type === "text" ? { ...l, upper: undefined, case: v === "typed" ? undefined : v } : l))}
                  />
                );
              })()}
            </Section>
          )}
          {text && (
            <Section
              title="Highlight"
              action={addOrRemove(
                picked.some((l) => l.type === "text" && !!l.marks?.length),
                "highlight",
                () => onPatch((l) => (l.type === "text" ? { ...l, marks: [{ color: "#f2b63c" }] } : l)),
                () => onPatch((l) => (l.type === "text" ? { ...l, marks: undefined } : l)),
              )}
            >
              {/* ponytail: the panel edits a text's first stroke; an AI may give it up to six, and those are kept as they are */}
              {one?.type === "text" && one.marks?.[0] && (
                <>
                  <div className="flex">{colour("The highlighter's colour", one.marks[0].color, (c) => (l) => (l.type === "text" && l.marks?.length ? { ...l, marks: [{ ...l.marks[0]!, color: c }, ...l.marks.slice(1)] } : l))}</div>
                  <input
                    key={`${one.id}:${one.marks[0].words ?? ""}`}
                    aria-label="Highlighted words"
                    placeholder="Every line"
                    defaultValue={one.marks[0].words ?? ""}
                    maxLength={200}
                    onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())}
                    onBlur={(e) => {
                      const words = e.currentTarget.value.replace(/\s+/g, " ").trim();
                      if (words !== (one.marks?.[0]?.words ?? "")) onPatch((l) => (l.type === "text" && l.marks?.length ? { ...l, marks: [{ ...l.marks[0]!, words: words || undefined }, ...l.marks.slice(1)] } : l));
                    }}
                    className={cn(FIELD, "w-full text-[11px] outline-none placeholder:text-zinc-400")}
                  />
                  <Choice
                    label="Highlight position"
                    value={one.marks[0].low ? "low" : "full"}
                    options={[["full", "Behind the letters"], ["low", "Sitting low"]] as const}
                    onPick={(v) => onPatch((l) => (l.type === "text" && l.marks?.length ? { ...l, marks: [{ ...l.marks[0]!, low: v === "low" ? true : undefined }, ...l.marks.slice(1)] } : l))}
                  />
                </>
              )}
            </Section>
          )}
          <Effects picked={picked} onPatch={onPatch} num={num} slide={slide} colour={colour} />
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
              <Choice label="Picture fit" value={same((l) => (l.type === "image" ? l.fit : undefined))} options={[["cover", "Fill"], ["contain", "Fit"]] as const} onPick={(fit) => onPatch((l) => (l.type === "image" ? { ...l, fit } : l))} />
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
                    Restore background
                  </button>
                ) : (
                  <button type="button" disabled={cutting} onClick={onCutOut} className="flex h-7 items-center justify-center gap-1.5 rounded-[5px] border border-[#e6e6e6] hover:bg-zinc-500/10 disabled:opacity-50 dark:border-[#4d4d4d]">
                    <CtMark className="size-3.5" />
                    {cutting ? "Working…" : "Remove background"}
                  </button>
                ))}
              {one?.type === "image" && (
                <button type="button" disabled={cutting} onClick={onSplit} className="flex h-7 items-center justify-center gap-1.5 rounded-[5px] border border-[#e6e6e6] hover:bg-zinc-500/10 disabled:opacity-50 dark:border-[#4d4d4d]">
                  <CtMark className="size-3.5" />
                  Split into layers
                </button>
              )}
            </Section>
          )}
          {image && (
            <Section
              title="Adjust"
              action={
                picked.some((l) => l.type === "image" && (l.adjust || l.duotone || l.vignette || l.grain || l.blur)) && (
                  <Tap label="Reset colours" onClick={() => onPatch((l) => (l.type === "image" ? { ...l, adjust: undefined, duotone: undefined, vignette: undefined, grain: undefined, blur: undefined } : l))}>
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

      {/* a picture lying loose on the canvas is no frame to save */}
      {!page.loose && (
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
      )}
    </aside>
  );
}

/** What a paint looks like on a swatch: its colour, its gradient, or its picture, over squares where it is see-through. */
function swatchOf(p: Paint, designId: string): string {
  if (p.type === "solid") return `linear-gradient(${p.color}, ${p.color}), ${CHECKS}`;
  if (p.type === "image") return `center / cover no-repeat url("${pictureUrl(designId, p.picture)}"), ${CHECKS}`;
  const stops = [...p.stops].sort((a, b) => a.at - b.at).map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(", ");
  const css = p.kind === "radial" || p.kind === "diamond" ? `radial-gradient(${stops})` : p.kind === "angular" ? `conic-gradient(from ${p.angle + 90}deg, ${stops})` : `linear-gradient(${p.angle + 90}deg, ${stops})`;
  return `${css}, ${CHECKS}`;
}

const GRADIENT_NAMES = { linear: "Linear", radial: "Radial", angular: "Angular", diamond: "Diamond" } as const;
const MODE_NAMES = { fill: "Fill", fit: "Fit", crop: "Crop", tile: "Tile" } as const;
const HEAD_NAMES = { none: "None", arrow: "Arrow", triangle: "Triangle", circle: "Circle", bar: "Bar" } as const;

/**
 * A list of fills or lines as rows, the top one first as it lies on the canvas: each row with a grip to drag it to
 * another place (pointer events, not the browser's drag and drop), its own fields, an eye that hides it and a minus
 * that takes it off. Lists that differ between the picked layers show as mixed until + gives them all one.
 */
function ListRows<T extends PaintLook>({ what, items, onSet, row }: { what: string; items: T[] | null; onSet: (items: T[], merge?: string) => void; row: (item: T, set: (item: T, merge?: string) => void) => ReactNode }) {
  const [drag, setDrag] = useState<{ from: number; dy: number; step: number } | null>(null);
  if (items === null) return <p className={DIM}>Mixed {what}s: + gives every picked layer one</p>;
  // shown top first: row n is the list's item at len - 1 - n
  const shown = [...items].reverse();
  const at = (n: number) => items.length - 1 - n;
  const grab = (e: React.PointerEvent<HTMLButtonElement>, n: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const row = e.currentTarget.closest<HTMLElement>("[data-row]");
    const step = (row?.offsetHeight ?? 24) + 8;
    const y0 = e.clientY;
    let dy = 0;
    setDrag({ from: n, dy, step });
    const move = (ev: PointerEvent) => setDrag({ from: n, dy: (dy = ev.clientY - y0), step });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrag(null);
      const to = Math.max(0, Math.min(items.length - 1, n + Math.round(dy / step)));
      if (to !== n) onSet(moved(items, at(n), at(to)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const to = drag && Math.max(0, Math.min(items.length - 1, drag.from + Math.round(drag.dy / drag.step)));
  return (
    <div className="flex flex-col gap-2">
      {shown.map((item, n) => {
        // the rows between where it was and where it goes make room for it
        const shift = drag && to !== null && n !== drag.from ? (drag.from < n && n <= to ? -drag.step : to <= n && n < drag.from ? drag.step : 0) : 0;
        return (
          <div key={n} data-row className={cn("flex flex-col gap-2", drag?.from === n && "relative z-10")} style={{ transform: `translateY(${drag?.from === n ? drag.dy : shift}px)` }}>
            {/* the grip, eye and minus beside its first line, however many lines its settings take */}
            <div className={cn("flex items-start gap-1", item.hidden && "opacity-50")}>
              <button type="button" aria-label={`Drag the ${what} to another place`} onPointerDown={(e) => grab(e, n)} className={cn("flex h-6 w-3 shrink-0 cursor-grab touch-none items-center justify-center", DIM)}>
                <GripVertical className="h-3 w-3" />
              </button>
              {row(item, (next, merge) => onSet(items.map((x, k) => (k === at(n) ? next : x)), merge))}
              <Tap label={item.hidden ? `Show the ${what}` : `Hide the ${what}`} onClick={() => onSet(items.map((x, k) => (k === at(n) ? { ...x, hidden: x.hidden ? undefined : true } : x)))}>
                {item.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Tap>
              <Tap label={`Remove the ${what}`} onClick={() => onSet(items.filter((_, k) => k !== at(n)))}>
                <Minus className="h-3.5 w-3.5" />
              </Tap>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A paint's opacity in percent, as a small number field. */
function OpacityNum({ value, onLive, onCommit }: { value: number | undefined; onLive: (n: number | null) => void; onCommit: (n: number | undefined) => void }) {
  return (
    <div className="w-14 shrink-0">
      <Num label="%" title="Opacity in percent" value={Math.round((value ?? 1) * 100)} min={0} max={100} onLive={onLive} onCommit={(n) => onCommit(n >= 100 ? undefined : n / 100)} />
    </div>
  );
}

/** A gradient's colours on a strip: each stop a handle to drag along it (or pick), a press between them adds one there. */
export function StopsBar({ stops, picked, onPick, onSet }: { stops: GradientStop[]; picked: number; onPick: (n: number) => void; onSet: (stops: GradientStop[], merge?: string) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const gestures = useRef(0);
  // a drag still on when the bar goes (its popover closed mid-drag) lets go of the window
  const ending = useRef<(() => void) | null>(null);
  useEffect(() => () => ending.current?.(), []);
  const place = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (x - r.left) / r.width)) * 100) / 100;
  };
  const slide = (e: React.PointerEvent, n: number) => {
    e.preventDefault();
    e.stopPropagation();
    onPick(n);
    const merge = `stop ${++gestures.current}`;
    const move = (ev: PointerEvent) => onSet(stops.map((s, k) => (k === n ? { ...s, at: place(ev.clientX) } : s)), merge);
    const up = () => {
      ending.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    ending.current?.();
    ending.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const css = [...stops].sort((a, b) => a.at - b.at).map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(", ");
  return (
    <div
      ref={bar}
      role="group"
      aria-label="Gradient colours"
      onPointerDown={(e) => {
        if (stops.length >= DESIGN_LIMITS.stops) return;
        const at = place(e.clientX);
        onSet([...stops, { at, color: colourAt(stops, at) }]);
        onPick(stops.length);
      }}
      className="relative mx-1.5 h-4 cursor-copy rounded-sm border border-black/15 dark:border-white/20"
      style={{ background: `linear-gradient(to right, ${css}), ${CHECKS}` }}
    >
      {stops.map((s, n) => (
        <button
          key={n}
          type="button"
          aria-label={`Colour at ${Math.round(s.at * 100)}%`}
          aria-pressed={n === picked}
          onPointerDown={(e) => slide(e, n)}
          className={cn("absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[3px] border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]", n === picked ? "border-[#0d99ff]" : "border-white")}
          style={{ left: `${s.at * 100}%`, background: `linear-gradient(${s.color}, ${s.color}), ${CHECKS}` }}
        />
      ))}
    </div>
  );
}

/** One fill's own settings, in the popover its swatch opens: what it is (a colour, a gradient, a picture) and how it looks. */
function PaintEditor({ paint, design, colours, onSet, onDropper }: { paint: Paint; design: Design; colours: readonly string[]; onSet: (p: Paint, merge?: string) => void; onDropper?: (take: (hex: string) => void) => void }) {
  const [stop, setStop] = useState(0);
  const opened = useRef(Math.random());
  const look = { ...(paint.hidden ? { hidden: true } : {}), ...(paint.opacity !== undefined ? { opacity: paint.opacity } : {}), ...(paint.blend ? { blend: paint.blend } : {}) };
  const first = paint.type === "solid" ? paint.color : paint.type === "gradient" ? (paint.stops[0]?.color ?? "#000000") : "#d9d9d9";
  const turn = (type: Paint["type"]) => {
    if (type === paint.type) return;
    if (type === "solid") onSet({ type, color: first, ...look });
    else if (type === "gradient") onSet({ type, angle: 90, stops: [{ at: 0, color: first }, { at: 1, color: "#000000" }], ...look });
    else if (design.pictures[0]) onSet({ type, picture: design.pictures[0], mode: "fill", ...look });
  };
  const s = paint.type === "gradient" ? Math.min(stop, paint.stops.length - 1) : 0;
  return (
    <div className="flex w-[208px] flex-col gap-2.5 text-[11px]">
      <Choice label="Fill kind" value={paint.type} options={[["solid", "Colour"], ["gradient", "Gradient"], ...(design.pictures.length ? [["image", "Picture"] as const] : [])] as const} onPick={turn} />
      {paint.type === "solid" && <ColourPicker alpha value={paint.color} colours={colours} onSet={(c, g) => onSet({ ...paint, color: c }, `paint ${opened.current}.${g}`)} onDropper={onDropper && (() => onDropper((c) => onSet({ ...paint, color: c })))} />}
      {paint.type === "gradient" && (
        <>
          <PickOne label="Gradient kind" value={GRADIENT_NAMES[paint.kind ?? "linear"]} options={DESIGN_GRADIENTS.map((k) => [k, GRADIENT_NAMES[k]] as const)} onPick={(k) => onSet({ ...paint, kind: k === "linear" ? undefined : k })} />
          {paint.kind !== "radial" && paint.kind !== "diamond" && <Num label="∠" title="Gradient angle in degrees" value={paint.angle} min={-360} max={360} onCommit={(n) => onSet({ ...paint, angle: n })} />}
          <StopsBar stops={paint.stops} picked={s} onPick={setStop} onSet={(stops, merge) => onSet({ ...paint, stops }, merge)} />
          <div className="flex items-center justify-between">
            <span className={DIM}>Colour at {Math.round(paint.stops[s]!.at * 100)}%</span>
            <Tap label="Remove this colour" disabled={paint.stops.length <= 2} onClick={() => (onSet({ ...paint, stops: paint.stops.filter((_, k) => k !== s) }), setStop(0))}>
              <Minus className="h-3.5 w-3.5" />
            </Tap>
          </div>
          <ColourPicker alpha value={paint.stops[s]!.color} colours={colours} onSet={(c, g) => onSet({ ...paint, stops: paint.stops.map((x, k) => (k === s ? { ...x, color: c } : x)) }, `paint ${opened.current}.${s}.${g}`)} />
        </>
      )}
      {paint.type === "image" && (
        <>
          <div className="grid grid-cols-4 gap-1.5">
            {design.pictures.map((id) => (
              <button key={id} type="button" aria-label="Fill with this picture" aria-pressed={id === paint.picture} onClick={() => onSet({ ...paint, picture: id })} className={cn("aspect-square rounded-[4px] border border-black/15 bg-cover bg-center dark:border-white/20", id === paint.picture && "outline outline-2 outline-offset-1 outline-[#0d99ff]")} style={{ backgroundImage: `url("${pictureUrl(design.id, id)}")` }} />
            ))}
          </div>
          <Choice label="How the picture lies" value={paint.mode} options={DESIGN_PICTURE_MODES.map((m) => [m, MODE_NAMES[m]] as const)} onPick={(mode) => onSet({ ...paint, mode, crop: mode === "crop" ? (paint.crop ?? { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }) : undefined, scale: mode === "tile" ? (paint.scale ?? 0.25) : undefined })} />
          {paint.mode === "tile" && <Slide label="Tile size" value={Math.round((paint.scale ?? 0.25) * 100)} min={2} max={100} onLive={() => {}} onCommit={(n) => onSet({ ...paint, scale: n / 100 })} />}
          {paint.mode === "crop" && (
            <div className="grid grid-cols-2 gap-2">
              {(["x", "y", "w", "h"] as const).map((k) => {
                const c = paint.crop ?? { x: 0, y: 0, w: 1, h: 1 };
                const size = k === "w" || k === "h";
                // a crop stays inside the picture: its corner moves in when its size grows
                const set = (n: number) => {
                  const v = n / 100;
                  const next = { ...c, [k]: v };
                  next.x = Math.min(next.x, 1 - next.w);
                  next.y = Math.min(next.y, 1 - next.h);
                  onSet({ ...paint, crop: next });
                };
                return <Num key={k} label={k.toUpperCase()} title={{ x: "Crop from the left in percent", y: "Crop from the top in percent", w: "Crop width in percent", h: "Crop height in percent" }[k]} value={Math.round(c[k] * 100)} min={size ? 1 : 0} max={size ? 100 : 99} onCommit={set} />;
              })}
            </div>
          )}
        </>
      )}
      <PickOne label="Fill blend" value={paint.blend ? BLEND_NAMES[paint.blend] : "Normal"} options={[["normal", "Normal"] as const, ...DESIGN_BLENDS.map((b) => [b, BLEND_NAMES[b]] as const)]} onPick={(b) => onSet({ ...paint, blend: b === "normal" ? undefined : b })} />
    </div>
  );
}

/** A fills section: + adds a colour on top, each row a swatch that opens its settings, its colour or kind, its opacity. */
function FillList({ fills, design, colours, onSet, onLive, onDropper, base }: { fills: Paint[] | null; design: Design; colours: readonly string[]; onSet: (fills: Paint[], merge?: string) => void; onLive: (fills: Paint[] | null) => void; onDropper?: (take: (hex: string) => void) => void; base: string }) {
  return (
    <Section
      title="Fill"
      action={
        <Tap label="Add a fill" onClick={() => onSet([...(fills ?? []), { type: "solid", color: fills?.length ? "#000000" : base }])}>
          <Plus className="h-3.5 w-3.5" />
        </Tap>
      }
    >
      <ListRows
        what="fill"
        items={fills}
        onSet={onSet}
        row={(p, set) => (
          <>
            <div className={cn(FIELD, "flex-1")}>
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" aria-label="Fill settings" className="h-4 w-4 shrink-0 rounded-sm border border-black/15 dark:border-white/20" style={{ background: swatchOf(p, design.id) }} />
                </PopoverTrigger>
                <PopoverContent side="left" align="start" sideOffset={14} className="w-auto border-[#e6e6e6] bg-white p-3 text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]">
                  <PaintEditor paint={p} design={design} colours={colours} onSet={set} onDropper={onDropper} />
                </PopoverContent>
              </Popover>
              {p.type === "solid" ? (
                <input
                  key={p.color}
                  aria-label="Fill as a hex code"
                  defaultValue={p.color.slice(1, 7).toUpperCase()}
                  maxLength={9}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())}
                  onBlur={(e) => {
                    const typed = typedHex(e.currentTarget.value);
                    const hex = typed && (typed.length === 7 ? withAlpha(typed, alphaOf(p.color)) : typed);
                    if (hex && hex !== p.color) set({ ...p, color: hex });
                  }}
                  className="w-full min-w-0 bg-transparent uppercase outline-none"
                />
              ) : (
                <span className="truncate">{p.type === "gradient" ? GRADIENT_NAMES[p.kind ?? "linear"] : "Picture"}</span>
              )}
            </div>
            <OpacityNum
              value={p.type === "solid" ? alphaOf(p.color) * (p.opacity ?? 1) : p.opacity}
              onLive={(n) => onLive(n === null || !fills ? null : fills.map((x) => (x === p ? { ...x, opacity: n / 100 } : x)))}
              // a colour's own see-through part is its opacity: one number, as the hex code says it
              onCommit={(o) => set(p.type === "solid" ? { ...p, color: withAlpha(p.color, o ?? 1), opacity: undefined } : { ...p, opacity: o })}
            />
          </>
        )}
      />
    </Section>
  );
}

const EFFECT_NAMES: Record<Effect["type"], string> = { shadow: "Drop shadow", "inner-shadow": "Inner shadow", blur: "Layer blur", "progressive-blur": "Progressive blur", "background-blur": "Background blur", noise: "Noise" };
/** A new effect of a kind, as + gives it or a change of kind makes it of one there (a shadow stays the shadow it was, a blur keeps how much). */
function effectNew(type: Effect["type"], was?: Effect): Effect {
  const shadowy = (t: Effect["type"]) => t === "shadow" || t === "inner-shadow";
  if (was && shadowy(was.type) && shadowy(type)) return { ...(was as Extract<Effect, { color: string }>), type: type as "shadow" | "inner-shadow" };
  const blur = was && "blur" in was && !shadowy(was.type) ? was.blur : undefined;
  if (type === "shadow" || type === "inner-shadow") return { type, color: "#000000", opacity: 0.25, blur: 16, x: 0, y: type === "shadow" ? 8 : 4 };
  if (type === "progressive-blur") return { type, blur: blur ?? 40, from: 0.45, to: 1, angle: 90 };
  if (type === "noise") return { type, amount: 15, size: 2 };
  return { type, blur: blur ?? 24 };
}

/**
 * The picked layers' effects, the top one first (as it is drawn: the last in the list): each one's kind, its numbers,
 * a switch to hide it and a − to take it off; dragged by its handle to another place in the list. A few ready-made
 * sets in Presets. Layers whose lists differ show none, and + gives each one more.
 */
function Effects({ picked, onPatch, num, slide, colour }: {
  picked: Layer[];
  onPatch: (fn: (l: Layer) => Layer, merge?: string) => void;
  num: (label: ReactNode, title: string, value: number | null, to: (n: number) => (l: Layer) => Layer, more?: { min?: number; max?: number; step?: number }) => ReactNode;
  slide: (label: string, value: number | null, to: (n: number) => (l: Layer) => Layer, min: number, max: number) => ReactNode;
  colour: (title: string, value: string | null, to: (c: string) => (l: Layer) => Layer) => ReactNode;
}) {
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const lists = picked.map(effectsOf);
  const list = lists.every((x) => JSON.stringify(x) === JSON.stringify(lists[0])) ? (lists[0] ?? []) : null;
  /** Each picked layer with its effect at `n` (in the list's own order) through `f`. */
  const edit = (n: number, f: (e: Effect) => Effect) => (l: Layer) => withEffects(l, effectsOf(l).map((e, i) => (i === n ? f(e) : e)));
  const set = (n: number, more: Partial<Record<string, number | string>>) => edit(n, (e) => ({ ...e, ...more }) as Effect);
  /** The row under the pointer while one is dragged (the first or the last when it is past them). */
  const rowAt = (y: number) => {
    const at = rows.current.findIndex((el) => el && y < el.getBoundingClientRect().bottom);
    return at < 0 ? (list?.length ?? 1) - 1 : at;
  };
  const shown = list ? [...list].reverse() : [];
  return (
    <Section
      title="Effects"
      action={
        <div className="flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger className={cn("h-6 rounded-[5px] px-1.5 outline-none hover:bg-zinc-500/15", DIM)}>Presets</DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {EFFECT_PRESETS.map((p) => (
                <DropdownMenuItem key={p.name} onSelect={() => onPatch((l) => withEffects(l, p.effects))}>
                  {p.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tap label="Add an effect" disabled={lists.some((x) => x.length >= EFFECTS_MAX)} onClick={() => onPatch((l) => withEffects(l, [...effectsOf(l), effectNew("shadow")]))}>
            <Plus className="h-3.5 w-3.5" />
          </Tap>
        </div>
      }
    >
      {!list && <p className={DIM}>Each layer has its own</p>}
      {shown.map((e, r) => {
        const n = shown.length - 1 - r;
        const pct = (v: number) => Math.round(v * 100);
        return (
          <div key={r} ref={(el) => void (rows.current[r] = el)} className={cn("flex flex-col gap-2 rounded-[5px]", drag && drag.to === r && drag.from !== r && "ring-1 ring-[#0d99ff]")}>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Drag to reorder"
                className={cn("flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center", DIM)}
                onPointerDown={(ev) => {
                  if (ev.button !== 0) return;
                  ev.currentTarget.setPointerCapture(ev.pointerId);
                  setDrag({ from: r, to: r });
                }}
                onPointerMove={(ev) => drag && setDrag({ ...drag, to: rowAt(ev.clientY) })}
                onPointerUp={() => {
                  setDrag(null);
                  if (!drag || drag.to === drag.from) return;
                  // the rows are the list upside down: row r is the list's (length - 1 - r)
                  const from = shown.length - 1 - drag.from;
                  const to = shown.length - 1 - drag.to;
                  onPatch((l) => {
                    const fx = [...effectsOf(l)];
                    const [moved] = fx.splice(from, 1);
                    fx.splice(to, 0, moved!);
                    return withEffects(l, fx);
                  });
                }}
                onPointerCancel={() => setDrag(null)}
              >
                <GripVertical className="h-3.5 w-3.5" />
              </button>
              <div className="min-w-0 flex-1">
                <PickOne label="Effect" value={EFFECT_NAMES[e.type]} options={DESIGN_EFFECTS.map((t) => [t, EFFECT_NAMES[t]] as const)} onPick={(t) => onPatch(edit(n, (was) => ({ ...effectNew(t, was), ...(was.hidden ? { hidden: true as const } : {}) })))} />
              </div>
              <Tap label={e.hidden ? "Show the effect" : "Hide the effect"} onClick={() => onPatch(edit(n, (x) => ({ ...x, hidden: x.hidden ? undefined : true })))}>
                {e.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Tap>
              <Tap label="Remove the effect" onClick={() => onPatch((l) => withEffects(l, effectsOf(l).filter((_, i) => i !== n)))}>
                <Minus className="h-3.5 w-3.5" />
              </Tap>
            </div>
            <div className={cn("flex flex-col gap-2", e.hidden && "opacity-50")}>
              {(e.type === "shadow" || e.type === "inner-shadow") && (
                <>
                  <div className="grid grid-cols-[1fr_4.5rem] gap-2">
                    {colour(`${EFFECT_NAMES[e.type]} colour`, e.color, (c) => set(n, { color: c }))}
                    {num("%", "Shadow strength in percent", pct(e.opacity), (v) => set(n, { opacity: v / 100 }), { min: 0, max: 100 })}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {num("X", "Shadow X", e.x, (v) => set(n, { x: v }), { min: -1000, max: 1000 })}
                    {num("Y", "Shadow Y", e.y, (v) => set(n, { y: v }), { min: -1000, max: 1000 })}
                    {num("◌", "Shadow blur", e.blur, (v) => set(n, { blur: v }), { min: 0, max: 400 })}
                    {num("⤢", "Shadow spread", e.spread ?? 0, (v) => set(n, { spread: v }), { min: -200, max: 200 })}
                  </div>
                </>
              )}
              {(e.type === "blur" || e.type === "background-blur" || e.type === "progressive-blur") && slide("Blur", e.blur, (v) => set(n, { blur: v }), 0, 200)}
              {e.type === "progressive-blur" && (
                <div className="grid grid-cols-3 gap-2">
                  {num("From", "Sharp up to, in percent of the layer", pct(e.from), (v) => set(n, { from: v / 100 }), { min: 0, max: 100 })}
                  {num("To", "Fully blurred from, in percent of the layer", pct(e.to), (v) => set(n, { to: v / 100 }), { min: 0, max: 100 })}
                  {num("∠", "Direction in degrees: 90 is top to bottom", e.angle, (v) => set(n, { angle: v }), { min: -360, max: 360 })}
                </div>
              )}
              {e.type === "noise" && (
                <>
                  {slide("Amount", e.amount, (v) => set(n, { amount: Math.max(1, v) }), 1, 100)}
                  <div className="grid grid-cols-2 gap-2">{num("◦", "Grain size in pixels", e.size ?? 1, (v) => set(n, { size: v }), { min: 1, max: 20 })}</div>
                </>
              )}
            </div>
          </div>
        );
      })}
    </Section>
  );
}

/** A strokes section: + adds a line on top, each row its colour, its width and its settings (side, dashes, ends, corners, a width a side, heads). */
function StrokeList({ strokes, colours, onSet, onLive, onDropper, max, text, box, open, inside }: { strokes: Stroke[] | null; colours: readonly string[]; onSet: (strokes: Stroke[], merge?: string) => void; onLive: (strokes: Stroke[] | null) => void; onDropper?: (take: (hex: string) => void) => void; max: number; text?: boolean; box?: boolean; open?: boolean; inside?: boolean }) {
  const [more, setMore] = useState<Stroke | null>(null);
  return (
    <Section
      title="Stroke"
      action={
        <Tap label="Add a stroke" onClick={() => onSet([...(strokes ?? []), { color: "#000000", width: 4, ...(inside ? { side: "inside" as const } : {}) }])}>
          <Plus className="h-3.5 w-3.5" />
        </Tap>
      }
    >
      <ListRows
        what="stroke"
        items={strokes}
        onSet={onSet}
        row={(s, set) => (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {/* its colour on a line of its own: beside the width and the settings there is no room left for the hex code */}
            <div className="flex">
              <Colour alpha title="Stroke" value={s.color} colours={colours} onDropper={onDropper} onSet={(color, merge) => set({ ...s, color }, merge)} />
            </div>
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <Num label="≡" title="Stroke width" value={s.width} min={0} max={max} onLive={(n) => onLive(n === null || !strokes ? null : strokes.map((x) => (x === s ? { ...x, width: n } : x)))} onCommit={(width) => set({ ...s, width })} />
              </div>
              {!text && (
                <Tap label="Stroke settings" on={more === s} onClick={() => setMore(more === s ? null : s)}>
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </Tap>
              )}
            </div>
            {more === s && (
              <StrokeMore
                s={s}
                box={box}
                open={open}
                max={max}
                set={(next) => {
                  setMore(next);
                  set(next);
                }}
              />
            )}
          </div>
        )}
      />
    </Section>
  );
}

/** A line's own settings: its side, dashes, ends and corners; a width a side round a box; heads on an open path. */
function StrokeMore({ s, box, open, max, set }: { s: Stroke; box?: boolean; open?: boolean; max: number; set: (s: Stroke) => void }) {
  const sides = s.sides;
  return (
    <div className="flex flex-col gap-2">
      {!open && <Choice label="Stroke side" value={s.side ?? "center"} options={[["center", "Centre"], ["inside", "Inside"], ["outside", "Outside"]] as const} onPick={(v) => set({ ...s, side: v === "center" ? undefined : v })} />}
      <div className="grid grid-cols-2 gap-2">
        {/* a dash with no gap is no dash: a dash typed first gets a gap as long as itself */}
        <Num label="┄" title="Dash length" value={s.dash?.[0] ?? 0} min={0} max={2000} onCommit={(n) => set({ ...s, dash: (s.dash?.[1] || n) > 0 ? [n, s.dash?.[1] || n] : undefined })} />
        <Num label="⋯" title="Gap between dashes" value={s.dash?.[1] ?? 0} min={0} max={2000} onCommit={(n) => set({ ...s, dash: n > 0 ? [s.dash?.[0] ?? n, n] : undefined })} />
      </div>
      <Choice label="Line ends" value={s.cap ?? (s.round ? "round" : "butt")} options={[["butt", "Flat"], ["round", "Round"], ["square", "Square"]] as const} onPick={(cap) => set({ ...s, cap: cap === "butt" ? undefined : cap, round: undefined })} />
      <Choice label="Line corners" value={s.join ?? "miter"} options={[["miter", "Sharp"], ["round", "Round"], ["bevel", "Cut"]] as const} onPick={(join) => set({ ...s, join: join === "miter" ? undefined : join })} />
      {box && (
        <div className="flex items-center gap-2">
          <div className="grid min-w-0 flex-1 grid-cols-4 gap-1">
            {sides &&
              (["Top", "Right", "Bottom", "Left"] as const).map((name, n) => (
                <Num key={name} label={name[0]} title={`${name} width`} value={sides[n]!} min={0} max={max} onCommit={(v) => set({ ...s, sides: sides.map((x, k) => (k === n ? v : x)) as [number, number, number, number] })} />
              ))}
          </div>
          <Tap label="A width for each side" on={!!sides} onClick={() => set({ ...s, sides: sides ? undefined : [s.width, s.width, s.width, s.width] })}>
            <Scan className="h-3.5 w-3.5" />
          </Tap>
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-2">
          <PickOne label="Start" value={`Start: ${HEAD_NAMES[s.start ?? "none"]}`} options={(["none", ...DESIGN_HEADS] as const).map((h) => [h, HEAD_NAMES[h]] as const)} onPick={(h) => set({ ...s, start: h === "none" ? undefined : h })} />
          <PickOne label="End" value={`End: ${HEAD_NAMES[s.end ?? "none"]}`} options={(["none", ...DESIGN_HEADS] as const).map((h) => [h, HEAD_NAMES[h]] as const)} onPick={(h) => set({ ...s, end: h === "none" ? undefined : h })} />
        </div>
      )}
    </div>
  );
}

export { Choice, Colour, Num, Section, Tap };
