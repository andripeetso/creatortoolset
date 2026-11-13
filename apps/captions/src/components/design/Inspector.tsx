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
  CaseUpper,
  Check,
  ChevronDown,
  FlipHorizontal2,
  FlipVertical2,
  Link2,
  Minus,
  Plus,
  Unlink2,
} from "lucide-react";
import type { Design, DesignPage, Layer } from "@contracts/design";
import { DESIGN_BLENDS, DESIGN_FORMATS, DESIGN_LIMITS, DESIGN_SHAPES } from "@contracts/design";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { typedHex } from "@/lib/design/colour";
import { boundsOf, frameOf, pageName, resizeAll, SHAPE_NAMES, type Align } from "@/lib/design/hands";
import { DESIGN_FONTS, designWeight } from "@/lib/design/fonts";
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
const BLEND_NAMES = { multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken", lighten: "Lighten", "soft-light": "Soft light" } as const;
/** How a frame or the picked layers are saved as pictures: PNG or JPEG, at their size or twice it. */
export interface ExportAs {
  jpeg: boolean;
  scale: number;
}

/** A choice of a few, as a row of buttons with the chosen one raised. */
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
  zoom,
  onZoom,
  onExport,
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
  zoom: number;
  onZoom: (to: "in" | "out" | "fit" | "selection" | number) => void;
  /** every frame, or the one at this place, saved as said */
  onExport: (only: number | undefined, as: ExportAs) => void;
  /** the colours the design already uses, for the picker */
  colours: readonly string[];
  /** the next press on the canvas gives its colour to `take` */
  onDropper: (take: (hex: string) => void) => void;
}) {
  const [ratio, setRatio] = useState(false);
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
  const colour = (title: string, value: string | null, to: (c: string) => (l: Layer) => Layer) => <Colour title={title} value={value} colours={colours} onDropper={onDropper} onSet={(c, merge) => onPatch(to(c), merge)} />;
  /** The picked layers resized so the box round them is `w` × `h` (one layer: that layer; with the lock, in its shape). */
  const sized = (w: number, h: number) => (l: Layer) => (box ? resizeAll([l], box, { x: box.x, y: box.y, w, h })[0]! : l);

  const text = every((l) => l.type === "text");
  const shape = every((l) => l.type === "shape");
  const image = every((l) => l.type === "image");
  /** The gradient of a text or a shape (a picture and a drawing have none). */
  const gradOf = (l: Layer) => (l.type === "shape" || l.type === "text" ? l.gradient : undefined);
  const setGrad = (g: { to: string; angle: number } | undefined) => (l: Layer): Layer => (l.type === "shape" || l.type === "text" ? { ...l, gradient: g } : l);
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
  const hasLine = picked.some((l) => (l.type === "shape" && l.stroke) || (l.type === "text" && l.outline));
  const setLine = (v: { color: string; width: number } | undefined) => (l: Layer): Layer => (l.type === "shape" ? { ...l, stroke: v } : l.type === "text" ? { ...l, outline: v } : l);
  const lineOf = (l: Layer) => (l.type === "shape" ? l.stroke : l.type === "text" ? l.outline : undefined);
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
        <h2 className="font-semibold">{picked.length > 1 ? `${picked.length} selected` : one ? (one.type === "text" ? "Text" : one.type === "image" ? "Picture" : one.type === "drawing" ? "Drawing" : SHAPE_NAMES[one.shape]) : "Frame"}</h2>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Zoom" className="flex h-6 items-center gap-0.5 rounded-[5px] px-1.5 hover:bg-zinc-500/15">
            {Math.round(zoom * 100)}%
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
      </div>

      {!box && (
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
                num("◜", "Corner radius", same((l) => (l.type === "image" || l.type === "shape" ? (l.radius ?? 0) : undefined)), (n) => (l) => (l.type === "image" || l.type === "shape" ? { ...l, radius: n || undefined } : l), { min: 0, max: 2000 })}
            </div>
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
          {(shape || text) && (
            <Section title="Fill" action={addOrRemove(hasGrad, "gradient", () => onPatch(setGrad(GRADIENT)), () => onPatch(setGrad(undefined)))}>
              <div className="flex">{colour("Fill", same((l) => (l.type === "shape" ? l.fill : l.type === "text" ? l.color : undefined)), (c) => (l) => (l.type === "shape" ? { ...l, fill: c } : l.type === "text" ? { ...l, color: c } : l))}</div>
              {hasGrad && (
                <div className="grid grid-cols-[1fr_4.5rem] gap-2">
                  {colour("Gradient to", same((l) => gradOf(l)?.to), (c) => (l) => setGrad({ angle: gradOf(l)?.angle ?? GRADIENT.angle, to: c })(l))}
                  {num("∠", "Gradient angle in degrees", same((l) => gradOf(l)?.angle), (n) => (l) => setGrad({ to: gradOf(l)?.to ?? GRADIENT.to, angle: n })(l), { min: -360, max: 360 })}
                </div>
              )}
            </Section>
          )}
          {(shape || text) && (
            <Section
              title="Stroke"
              action={addOrRemove(hasLine, "stroke", () => onPatch(setLine({ color: "#000000", width: 4 })), () => onPatch(setLine(undefined)))}
            >
              {hasLine && (
                <div className="grid grid-cols-[1fr_4.5rem] gap-2">
                  {colour("Stroke", same((l) => lineOf(l)?.color), (c) => (l) => setLine({ width: lineOf(l)?.width ?? 4, color: c })(l))}
                  {num("≡", "Stroke width", same((l) => lineOf(l)?.width), (n) => (l) => setLine(n > 0 ? { color: lineOf(l)?.color ?? "#000000", width: n } : undefined)(l), { min: 0, max: shape ? 200 : 60 })}
                </div>
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
            <Section title="Picture">
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
            </Section>
          )}
        </>
      )}

      <Section title="Export">
        <div className="grid grid-cols-2 gap-2">
          <Choice label="File type" value={as.jpeg ? "jpeg" : "png"} options={[["png", "PNG"], ["jpeg", "JPG"]] as const} onPick={(t) => setAs({ ...as, jpeg: t === "jpeg" })} />
          <Choice label="Size" value={as.scale} options={[[1, "1×"], [2, "2×"]] as const} onPick={(scale) => setAs({ ...as, scale })} />
        </div>
        <button type="button" onClick={() => onExport(at, as)} className="flex h-7 items-center justify-center rounded-[5px] border border-[#e6e6e6] hover:bg-zinc-500/10 dark:border-[#4d4d4d]">
          Export {pageName(page, at)}
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
