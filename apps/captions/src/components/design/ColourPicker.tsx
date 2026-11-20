import { useRef, useState } from "react";
import { Pipette } from "lucide-react";
import { alphaOf, toHex, toHsv, typedHex, withAlpha } from "@/lib/design/colour";
import { cn } from "@/lib/utils";
import { Tip } from "./Tip";

/**
 * The colour picker: a square of every strength and lightness of one hue, the strip of hues under it, the colour as
 * a hex code, the colours the canvas already uses, a few plain ones, and a dropper that takes a colour from the
 * canvas. With `alpha`, also how solid the colour is (a strip and a percentage), kept as "#rrggbbaa". Every colour it
 * passes is set at once; `gesture` counts its drags and presses, so each one is a step of its own to undo.
 */

/** A see-through colour shown over squares, so how see-through it is can be seen. */
export const CHECKS = "repeating-conic-gradient(#c8c8c8 0 25%, #ffffff 0 50%) 0 0 / 8px 8px";

const PLAIN = ["#000000", "#ffffff", "#9ca3af", "#f24822", "#ffa629", "#ffcd29", "#14ae5c", "#0d99ff", "#9747ff"];
const W = 208;
const H = 132;

export function ColourPicker({ value, colours, onSet, onDropper, alpha = false }: { value: string; colours: readonly string[]; onSet: (hex: string, gesture: number) => void; onDropper?: () => void; alpha?: boolean }) {
  const at = toHsv(value);
  const solid = alpha ? alphaOf(value) : 1;
  const six = value.slice(0, 7);
  /** A colour picked in the square or the strip of hues, as solid as the colour was. */
  const keep = (hex: string) => withAlpha(hex, solid);
  // a grey or black has no hue of its own: the square stays on the hue it was on
  const [hue, setHue] = useState(at.h);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    if (at.s > 0 && at.v > 0) setHue(at.h);
  }
  const [draft, setDraft] = useState<string | null>(null);
  const gesture = useRef(0);

  /** Follows the pointer over `el`, giving its place as 0 to 1 across and down. */
  const follow = (e: React.PointerEvent<HTMLDivElement>, to: (x: number, y: number) => void) => {
    e.preventDefault();
    const el = e.currentTarget;
    const place = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      to(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    const move = (ev: PointerEvent) => place(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    place(e);
  };

  const swatch = (c: string) => (
    <button key={c} type="button" aria-label={c.toUpperCase()} onClick={() => onSet(alpha ? c : c.slice(0, 7), ++gesture.current)} className={cn("h-5 w-5 rounded-[4px] border border-black/15 dark:border-white/20", c === value && "outline outline-2 outline-offset-1 outline-[#0d99ff]")} style={{ background: `linear-gradient(${c}, ${c}), ${CHECKS}` }} />
  );

  return (
    <div className="flex flex-col gap-2.5 text-[11px]" style={{ width: W }}>
      <div
        role="slider"
        aria-label="Strength and lightness"
        aria-valuetext={value.toUpperCase()}
        tabIndex={-1}
        onPointerDown={(e) => {
          const id = ++gesture.current;
          follow(e, (x, y) => onSet(keep(toHex({ h: hue, s: x, v: 1 - y })), id));
        }}
        className="relative cursor-crosshair touch-none rounded-md"
        style={{ height: H, background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hue} 100% 50%))` }}
      >
        <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" style={{ left: `${at.s * 100}%`, top: `${(1 - at.v) * 100}%`, background: six }} />
      </div>
      <div
        role="slider"
        aria-label="Hue"
        aria-valuenow={Math.round(hue)}
        aria-valuemin={0}
        aria-valuemax={360}
        tabIndex={-1}
        onPointerDown={(e) => {
          const id = ++gesture.current;
          follow(e, (x) => {
            const h = Math.min(359.9, x * 360);
            setHue(h);
            // a grey gets enough colour to show the hue picked
            onSet(keep(toHex({ h, s: at.s || 1, v: at.v || 1 })), id);
          });
        }}
        className="relative h-3 cursor-pointer touch-none rounded-full"
        style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
      >
        <span className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" style={{ left: `${(hue / 360) * 100}%`, background: `hsl(${hue} 100% 50%)` }} />
      </div>
      {alpha && (
        <div
          role="slider"
          aria-label="Opacity"
          aria-valuenow={Math.round(solid * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={-1}
          onPointerDown={(e) => {
            const id = ++gesture.current;
            follow(e, (x) => onSet(withAlpha(six, Math.round(x * 100) / 100), id));
          }}
          className="relative h-3 cursor-pointer touch-none rounded-full"
          style={{ background: `linear-gradient(to right, ${six}00, ${six}), ${CHECKS}` }}
        >
          <span className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" style={{ left: `${solid * 100}%`, background: `linear-gradient(${value}, ${value}), ${CHECKS}` }} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-[5px] bg-[#f5f5f5] px-1.5 focus-within:outline focus-within:outline-1 focus-within:outline-[#0d99ff] dark:bg-[#383838]">
          <span className="text-zinc-500 dark:text-[#b3b3b3]">#</span>
          <input
            aria-label="Hex code"
            value={draft ?? six.slice(1).toUpperCase()}
            maxLength={alpha ? 9 : 7}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())}
            onBlur={(e) => {
              const typed = typedHex(e.currentTarget.value);
              // six digits keep how solid the colour was; eight say it
              const hex = typed && (!alpha ? typed.slice(0, 7) : typed.length === 7 ? keep(typed) : typed);
              if (draft !== null && hex && hex !== value) onSet(hex, ++gesture.current);
              setDraft(null);
            }}
            className="w-full min-w-0 bg-transparent uppercase outline-none"
          />
        </label>
        {alpha && (
          <label className="flex h-6 w-14 shrink-0 items-center gap-0.5 rounded-[5px] bg-[#f5f5f5] px-1.5 focus-within:outline focus-within:outline-1 focus-within:outline-[#0d99ff] dark:bg-[#383838]">
            <input
              key={value}
              aria-label="Opacity in percent"
              inputMode="numeric"
              defaultValue={Math.round(solid * 100)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())}
              onBlur={(e) => {
                const n = Number(e.currentTarget.value);
                if (e.currentTarget.value.trim() !== "" && Number.isFinite(n) && Math.round(n) !== Math.round(solid * 100)) onSet(withAlpha(six, Math.min(100, Math.max(0, n)) / 100), ++gesture.current);
              }}
              className="w-full min-w-0 bg-transparent outline-none"
            />
            <span className="text-zinc-500 dark:text-[#b3b3b3]">%</span>
          </label>
        )}
        {onDropper && (
          <Tip label="Take a colour from the canvas">
            <button type="button" aria-label="Take a colour from the canvas" onClick={onDropper} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] hover:bg-zinc-500/15">
              <Pipette className="h-3.5 w-3.5" />
            </button>
          </Tip>
        )}
      </div>
      {colours.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-zinc-500 dark:text-[#b3b3b3]">On this canvas</p>
          <div className="flex flex-wrap gap-1.5">{colours.map(swatch)}</div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">{PLAIN.filter((c) => !colours.includes(c)).map(swatch)}</div>
    </div>
  );
}
