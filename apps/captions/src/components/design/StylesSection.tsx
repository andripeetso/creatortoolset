import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Minus, Plus, SlidersHorizontal, Unlink2 } from "lucide-react";
import type { DesignStyles, DesignTextStyle, Effect, Layer, TextLayer } from "@contracts/design";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { effectsOf, withEffects } from "@/lib/design/effects";
import { DESIGN_FONTS, designWeight } from "@/lib/design/fonts";
import { useOwnFonts } from "@/lib/design/own-fonts";
import { coloursOf, styleId, styleOf, stylesFull, swapColour, textStyleOf, withStyle } from "@/lib/design/styles";
import { cn } from "@/lib/utils";
import { CHECKS } from "./ColourPicker";
import { Colour, DIM, Effects, FIELD, fieldsFor, Num, PickOne, Section, Tap } from "./Inspector";

/**
 * The design's styles in the panels (lib/design/styles.ts): the lists to name one from beside a colour, a text and
 * effects, the Styles section that adds, renames, edits and deletes them, and the colours of what is picked. The
 * designer gives them through DesignStylesContext; without it (a text clip in the video editor) none of this shows.
 */

export type StylesCtx = { styles: DesignStyles; set: (fn: (s: DesignStyles) => DesignStyles, merge?: string) => void; locked?: boolean };
export const DesignStylesContext = createContext<StylesCtx | null>(null);
export const useDesignStyles = () => useContext(DesignStylesContext);

const ROW = "flex h-7 w-full min-w-0 items-center gap-2 rounded-[5px] px-1.5 text-left hover:bg-zinc-500/10";
const Dot = ({ color }: { color: string }) => <span className="h-4 w-4 shrink-0 rounded-sm border border-black/15 dark:border-white/20" style={{ background: `linear-gradient(${color}, ${color}), ${CHECKS}` }} />;
const POP = "w-auto border-[#e6e6e6] bg-white p-3 text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]";

/** A + that becomes a field for a new style's name: Enter (or leaving it) makes it, Escape does not. */
function NewStyle({ label, onMake }: { label: string; onMake: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className={cn(ROW, DIM)}>
        <Plus className="h-3.5 w-3.5 shrink-0" />
        {label}
      </button>
    );
  return (
    <input
      autoFocus
      aria-label={`${label}: its name`}
      placeholder="Name"
      maxLength={40}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") e.currentTarget.value = "";
        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
      }}
      onBlur={(e) => {
        const name = e.currentTarget.value.trim();
        setOpen(false);
        if (name) onMake(name);
      }}
      className={cn(FIELD, "outline-none")}
    />
  );
}

/** A style's name, typed over in place (leaving the field renames it). */
const NameField = ({ name, label, onName }: { name: string; label: string; onName: (name: string) => void }) => (
  <input
    key={name}
    aria-label={label}
    defaultValue={name}
    maxLength={40}
    onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())}
    onBlur={(e) => {
      const typed = e.currentTarget.value.trim();
      if (typed && typed !== name) onName(typed);
      else e.currentTarget.value = name;
    }}
    className="min-w-0 flex-1 bg-transparent outline-none"
  />
);

/**
 * The colour styles beside a colour picker: one pressed names that style (its colour), Detach keeps the colour and
 * names none, and a new one is made of the colour as it is and named at once.
 */
export function ColourStyles({ style, color, onPick }: { style?: string; color: string; onPick: (to: { color: string; style?: string }) => void }) {
  const ctx = useDesignStyles();
  if (!ctx) return null;
  const list = Object.entries(ctx.styles.colors ?? {});
  return (
    <div className="flex w-[208px] flex-col gap-1 text-[11px]">
      <div className="flex h-6 items-center justify-between">
        <p className={DIM}>Colour styles</p>
        {style && styleOf(ctx.styles, "colors", style) && !ctx.locked && (
          <Tap label="Detach style" onClick={() => onPick({ color })}>
            <Unlink2 className="h-3.5 w-3.5" />
          </Tap>
        )}
      </div>
      {list.length > 0 && (
        <ul aria-label="Colour styles" className="flex max-h-40 flex-col overflow-y-auto">
          {list.map(([id, st]) => (
            <li key={id}>
              <button type="button" aria-pressed={id === style} disabled={ctx.locked} onClick={() => onPick({ color: st.color, style: id })} className={cn(ROW, id === style && "bg-[#0d99ff]/15")}>
                <Dot color={st.color} />
                <span className="min-w-0 flex-1 truncate">{st.name}</span>
                {id === style && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!ctx.locked && !stylesFull(ctx.styles, "colors") && (
        <NewStyle
          label="New colour style"
          onMake={(name) => {
            const id = styleId(name, Object.keys(ctx.styles.colors ?? {}));
            ctx.set((s) => withStyle(s, "colors", id, { name, color }));
            onPick({ color, style: id });
          }}
        />
      )}
    </div>
  );
}

/** The name of the colour style a colour names, when there is one. */
export const colourStyleName = (ctx: StylesCtx | null, style: string | undefined) => (style ? styleOf(ctx?.styles, "colors", style)?.name : undefined);

const without = <L extends Layer>(l: L, ...keys: string[]): L => {
  const out = { ...l } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as L;
};

/** The text style of the picked texts: pick one from the list (the fields they set on top of it go), detach it, make one of a text, and a text changed on top of its style put back to it or made the style. */
export function TextStyleRow({ picked, onPatch }: { picked: Layer[]; onPatch: (fn: (l: Layer) => Layer, merge?: string) => void }) {
  const ctx = useDesignStyles();
  const [open, setOpen] = useState(false);
  if (!ctx) return null;
  const texts = picked.filter((l): l is TextLayer => l.type === "text");
  const ids = new Set(texts.map((t) => t.textStyle ?? ""));
  const now = ids.size === 1 ? [...ids][0]! : null;
  const st = now ? styleOf(ctx.styles, "text", now) : undefined;
  const own = texts.some((t) => t.styleOwn?.length);
  const list = Object.entries(ctx.styles.text ?? {});
  const apply = (id: string) => onPatch((l) => (l.type === "text" ? without({ ...l, textStyle: id }, "styleOwn") : l));
  const one = texts.length === 1 ? texts[0]! : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Text style" disabled={ctx.locked} className={cn(FIELD, "flex-1 justify-between outline-none")}>
              <span className="truncate">{st ? `${st.name}${own ? " (changed)" : ""}` : now === null ? "Mixed" : "No text style"}</span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="left" align="start" sideOffset={14} className={POP}>
            <div className="flex w-[208px] flex-col gap-1 text-[11px]">
              <p className={DIM}>Text styles</p>
              {list.length > 0 && (
                <ul aria-label="Text styles" className="flex max-h-56 flex-col overflow-y-auto">
                  {list.map(([id, s]) => (
                    <li key={id}>
                      <button type="button" aria-pressed={id === now} onClick={() => (apply(id), setOpen(false))} className={cn(ROW, "h-auto py-1", id === now && "bg-[#0d99ff]/15")}>
                        <span className="min-w-0 flex-1 truncate text-[13px]" style={{ fontFamily: `"${s.font}", "Inter"`, fontWeight: s.weight ?? designWeight(s.font) }}>
                          {s.name}
                        </span>
                        <span className={cn("shrink-0", DIM)}>{s.size}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {one && !stylesFull(ctx.styles, "text") && (
                <NewStyle
                  label="New text style from this text"
                  onMake={(name) => {
                    const id = styleId(name, Object.keys(ctx.styles.text ?? {}));
                    ctx.set((s) => withStyle(s, "text", id, textStyleOf(one, name)));
                    apply(id);
                    setOpen(false);
                  }}
                />
              )}
            </div>
          </PopoverContent>
        </Popover>
        {st && (
          <Tap label="Detach style" onClick={() => onPatch((l) => (l.type === "text" ? without(l, "textStyle", "styleOwn") : l))}>
            <Unlink2 className="h-3.5 w-3.5" />
          </Tap>
        )}
      </div>
      {st && own && (
        <div className="flex gap-1">
          <button type="button" onClick={() => onPatch((l) => (l.type === "text" ? without(l, "styleOwn") : l))} className={cn(FIELD, "flex-1 justify-center")}>
            Reset to style
          </button>
          {one && (
            <button
              type="button"
              onClick={() => {
                ctx.set((s) => withStyle(s, "text", now!, textStyleOf(one, st.name)));
                onPatch((l) => (l.type === "text" ? without(l, "styleOwn") : l));
              }}
              className={cn(FIELD, "flex-1 justify-center")}
            >
              Update style
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The effect style of the picked layers: picked from the list, detached, or made of one layer's effects. */
export function EffectStyleRow({ picked, onPatch }: { picked: Layer[]; onPatch: (fn: (l: Layer) => Layer, merge?: string) => void }) {
  const ctx = useDesignStyles();
  const [open, setOpen] = useState(false);
  if (!ctx) return null;
  const ids = new Set(picked.map((l) => l.effectStyle ?? ""));
  const now = ids.size === 1 ? [...ids][0]! : null;
  const st = now ? styleOf(ctx.styles, "effects", now) : undefined;
  const list = Object.entries(ctx.styles.effects ?? {});
  const one = picked.length === 1 ? picked[0]! : null;
  if (!list.length && !(one && effectsOf(one).length)) return null;
  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" aria-label="Effect style" disabled={ctx.locked} className={cn(FIELD, "flex-1 justify-between outline-none")}>
            <span className="truncate">{st ? st.name : now === null ? "Mixed" : "No effect style"}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="left" align="start" sideOffset={14} className={POP}>
          <div className="flex w-[208px] flex-col gap-1 text-[11px]">
            <p className={DIM}>Effect styles</p>
            {list.length > 0 && (
              <ul aria-label="Effect styles" className="flex max-h-48 flex-col overflow-y-auto">
                {list.map(([id, s]) => (
                  <li key={id}>
                    <button type="button" aria-pressed={id === now} onClick={() => (onPatch((l) => withEffects({ ...l, effectStyle: id }, s.effects)), setOpen(false))} className={cn(ROW, id === now && "bg-[#0d99ff]/15")}>
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      {id === now && <Check className="h-3.5 w-3.5 shrink-0" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {one && effectsOf(one).length > 0 && !stylesFull(ctx.styles, "effects") && (
              <NewStyle
                label="New effect style from these effects"
                onMake={(name) => {
                  const id = styleId(name, Object.keys(ctx.styles.effects ?? {}));
                  ctx.set((s) => withStyle(s, "effects", id, { name, effects: effectsOf(one) }));
                  onPatch((l) => withEffects({ ...l, effectStyle: id }, effectsOf(one)));
                  setOpen(false);
                }}
              />
            )}
          </div>
        </PopoverContent>
      </Popover>
      {st && (
        <Tap label="Detach style" onClick={() => onPatch((l) => without(l, "effectStyle"))}>
          <Unlink2 className="h-3.5 w-3.5" />
        </Tap>
      )}
    </div>
  );
}

const CASES = [["typed", "As typed"], ["upper", "Upper case"], ["lower", "Lower case"], ["title", "Title case"], ["small", "Small capitals"]] as const;

/** A text style's own fields: its font, size, weight, line height, spacing and case. */
function TextStyleEditor({ st, onSet }: { st: DesignTextStyle; onSet: (st: DesignTextStyle) => void }) {
  const own = useOwnFonts();
  const fonts = [...DESIGN_FONTS.map((f) => [f.family, f.label] as const), ...own.map((f) => [f.family, f.family] as const)];
  const put = <K extends keyof DesignTextStyle>(k: K, v: DesignTextStyle[K] | undefined) => {
    const next = { ...st } as Record<string, unknown>;
    if (v === undefined) delete next[k];
    else next[k] = v;
    onSet(next as unknown as DesignTextStyle);
  };
  return (
    <div className="flex flex-col gap-2 pb-1">
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`${st.name}: font`} className={cn(FIELD, "w-full justify-between outline-none")}>
          <span className="truncate">{fonts.find(([f]) => f === st.font)?.[1] ?? st.font}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
          {fonts.map(([family, label]) => (
            <DropdownMenuItem key={family} onSelect={() => put("font", family)} className="flex items-center justify-between gap-2">
              <span className="truncate text-[15px] leading-6" style={{ fontFamily: `"${family}", "Inter"` }}>
                {label}
              </span>
              {st.font === family && <Check className="h-3.5 w-3.5 shrink-0" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="grid grid-cols-2 gap-2">
        <Num label="Aa" title={`${st.name}: size`} value={st.size} min={8} max={600} onCommit={(n) => put("size", n)} />
        <Num label="W" title={`${st.name}: weight`} value={st.weight ?? designWeight(st.font)} min={100} max={900} step={100} rate={0.1} onCommit={(n) => put("weight", Math.round(n / 100) * 100)} />
        <Num label="↕" title={`${st.name}: line height in percent`} value={Math.round((st.lineHeight ?? 1.15) * 100)} min={80} max={300} onCommit={(n) => put("lineHeight", n / 100)} />
        <Num label="↔" title={`${st.name}: letter spacing`} value={st.spacing ?? 0} min={-20} max={200} onCommit={(n) => put("spacing", n || undefined)} />
      </div>
      <PickOne label={`${st.name}: case`} value={CASES.find(([v]) => v === (st.case ?? "typed"))![1]} options={CASES} onPick={(v) => put("case", v === "typed" ? undefined : v)} />
    </div>
  );
}

/** A style's row of the Styles section: its name, what opens its settings, and taking it away. */
function StyleRow({ kind, name, lead, open, onOpen, onName, onDelete }: { kind: string; name: string; lead?: ReactNode; open?: boolean; onOpen?: () => void; onName: (n: string) => void; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {lead}
      <div className={cn(FIELD, "flex-1")}>
        <NameField name={name} label={`${kind} style name`} onName={onName} />
      </div>
      {onOpen && (
        <Tap label={`${name} settings`} on={open} onClick={onOpen}>
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </Tap>
      )}
      <Tap label={`Delete ${name}`} onClick={onDelete}>
        <Minus className="h-3.5 w-3.5" />
      </Tap>
    </div>
  );
}

/** An effect style's effects, edited as a layer's are (the Effects section on a stand-in layer). */
function EffectStyleEditor({ effects, colours, onSet }: { effects: Effect[]; colours: readonly string[]; onSet: (fx: Effect[], merge?: string) => void }) {
  const stand = { id: "style", type: "shape", shape: "rect", fill: "#000000", x: 0, y: 0, w: 1, h: 1, effects } as Layer;
  const onPatch = (fn: (l: Layer) => Layer, merge?: string) => onSet(effectsOf(fn(stand)), merge);
  const { num, slide, colour } = fieldsFor(() => {}, onPatch, colours);
  // (the stand-in names no effect style: no list of them here)
  return (
    <DesignStylesContext.Provider value={null}>
      <Effects picked={[stand]} onPatch={onPatch} num={num} slide={slide} colour={colour} />
    </DesignStylesContext.Provider>
  );
}

/**
 * The design's styles, with nothing picked: each colour, text and effect style to rename, edit and delete (what names a
 * deleted style keeps its value), and new ones. A change of one is a change of every layer naming it.
 */
export function StylesSection({ colours = [] }: { colours?: readonly string[] }) {
  const ctx = useDesignStyles();
  const [open, setOpen] = useState<string | null>(null);
  if (!ctx || ctx.locked) return null;
  const { styles, set } = ctx;
  const named = (kind: keyof DesignStyles, id: string) => (n: string) => set((s) => withStyle(s, kind, id, { ...(s[kind]![id] as object), name: n } as never));
  const gone = (kind: keyof DesignStyles, id: string) => () => set((s) => withStyle(s, kind, id, null));
  const toggle = (key: string) => setOpen(open === key ? null : key);
  return (
    <Section title="Styles">
      <p className={DIM}>Colours</p>
      {Object.entries(styles.colors ?? {}).map(([id, st]) => (
        <StyleRow
          key={id}
          kind="Colour"
          name={st.name}
          lead={
            <div className="flex w-[92px] shrink-0">
              <Colour alpha title={`${st.name} colour`} value={st.color} colours={colours} onSet={(c, merge) => set((s) => withStyle(s, "colors", id, { ...s.colors![id]!, color: c }), merge)} />
            </div>
          }
          onName={named("colors", id)}
          onDelete={gone("colors", id)}
        />
      ))}
      {!stylesFull(styles, "colors") && <NewStyle label="New colour style" onMake={(name) => set((s) => withStyle(s, "colors", styleId(name, Object.keys(s.colors ?? {})), { name, color: "#000000" }))} />}
      <p className={DIM}>Text</p>
      {Object.entries(styles.text ?? {}).map(([id, st]) => (
        <div key={id} className="flex flex-col gap-2">
          <StyleRow kind="Text" name={st.name} open={open === `t:${id}`} onOpen={() => toggle(`t:${id}`)} onName={named("text", id)} onDelete={gone("text", id)} />
          {open === `t:${id}` && <TextStyleEditor st={st} onSet={(next) => set((s) => withStyle(s, "text", id, next))} />}
        </div>
      ))}
      {!stylesFull(styles, "text") && <NewStyle label="New text style" onMake={(name) => set((s) => withStyle(s, "text", styleId(name, Object.keys(s.text ?? {})), { name, font: "Inter", size: 48 }))} />}
      <p className={DIM}>Effects</p>
      {Object.entries(styles.effects ?? {}).map(([id, st]) => (
        <div key={id} className="flex flex-col gap-2">
          <StyleRow kind="Effect" name={st.name} open={open === `e:${id}`} onOpen={() => toggle(`e:${id}`)} onName={named("effects", id)} onDelete={gone("effects", id)} />
          {open === `e:${id}` && <EffectStyleEditor effects={st.effects} colours={colours} onSet={(fx, merge) => set((s) => withStyle(s, "effects", id, { ...s.effects![id]!, effects: fx }), merge)} />}
        </div>
      ))}
      {!stylesFull(styles, "effects") && <NewStyle label="New effect style" onMake={(name) => set((s) => withStyle(s, "effects", styleId(name, Object.keys(s.effects ?? {})), { name, effects: [{ type: "shadow", color: "#000000", opacity: 0.2, blur: 24, x: 0, y: 8 }] }))} />}
    </Section>
  );
}

/**
 * Every colour the picked layers use (and those inside them), by the style it names or else its value: one changed
 * here is changed everywhere in what is picked, to a colour or to a style.
 */
export function SelectionColours({ picked, onPatch, colours }: { picked: Layer[]; onPatch: (fn: (l: Layer) => Layer, merge?: string) => void; colours: readonly string[] }) {
  const ctx = useDesignStyles();
  const list = coloursOf(picked);
  if (!list.length) return null;
  return (
    <Section title="Selection colours">
      {list.slice(0, 24).map((c, n) => (
        // by its place: a drag in the picker changes the colour, and the row (and its open picker) stays
        <SelectionColour key={n} c={c} ctx={ctx} colours={colours} onPatch={onPatch} />
      ))}
    </Section>
  );
}

function SelectionColour({ c, ctx, colours, onPatch }: { c: { color: string; style?: string }; ctx: StylesCtx | null; colours: readonly string[]; onPatch: (fn: (l: Layer) => Layer, merge?: string) => void }) {
  // what the colour is now: a drag in the picker swaps it again and again, each time from the one it set last
  const from = useRef<{ color: string; style?: string }>(c);
  from.current = c;
  const swap = (to: { color: string; style?: string }, merge?: string) => {
    const f = from.current;
    from.current = to;
    onPatch((l) => swapColour([l], f, to)[0]!, merge);
  };
  const name = colourStyleName(ctx, c.style);
  return (
    <div className="flex">
      <Colour alpha title={`${name ?? c.color.toUpperCase()} in the selection`} value={c.color} colours={colours} styled={ctx ? { style: c.style, onPick: (to) => swap(to) } : undefined} onSet={(hex, merge) => swap({ color: hex }, merge)} />
    </div>
  );
}
