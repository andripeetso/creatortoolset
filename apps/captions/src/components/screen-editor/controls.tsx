import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// The screen recording editor's controls: one look for every slider, switch, choice and swatch in its side panel.

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-3.5">
      {title && <h3 className="text-xs font-medium text-zinc-200">{title}</h3>}
      {children}
    </section>
  );
}

/** A slider with its name and value. With `initial`, a reset arrow shows once the value has left it. */
export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  initial,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  initial?: number;
}) {
  const moved = initial !== undefined && Math.abs(value - initial) > step / 2;
  return (
    <div className="space-y-2">
      <div className="flex h-4 items-center justify-between text-xs">
        <span className="text-zinc-400">{label}</span>
        <span className="flex items-center gap-1.5">
          {moved && (
            <button
              type="button"
              onClick={() => onChange(initial)}
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              aria-label={`Reset ${label.toLowerCase()}`}
              title="Reset"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
          <span className="min-w-8 text-right tabular-nums text-zinc-300">{format(value)}</span>
        </span>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        className="[&_[data-slot=slider-range]]:bg-violet-500 [&_[data-slot=slider-thumb]]:border-violet-500 [&_[data-slot=slider-thumb]]:hover:ring-violet-500/30 [&_[data-slot=slider-track]]:bg-zinc-800"
      />
    </div>
  );
}

export function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-zinc-400">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/** One choice out of a few, side by side. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-zinc-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={cn(
            "min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-xs transition-colors",
            value === o.id ? "bg-zinc-700 font-medium text-zinc-50 shadow-sm" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A grid of colour tiles; `fill` is each tile's CSS background. */
export function Swatches({
  value,
  options,
  onChange,
  label,
}: {
  value: string | null;
  options: { id: string; label: string; fill: string }[];
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-6 gap-2">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          aria-label={o.label}
          title={o.label}
          onClick={() => onChange(o.id)}
          className={cn(
            "aspect-square rounded-lg border border-zinc-700/60 outline-offset-2 transition-transform hover:scale-105",
            value === o.id && "outline outline-2 outline-violet-400",
          )}
          style={{ background: o.fill }}
        />
      ))}
    </div>
  );
}

/** A colour well with its hex value beside it. */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  return (
    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg bg-zinc-900 px-2 py-1.5">
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      <span className="truncate font-mono text-[11px] uppercase text-zinc-300">{value}</span>
    </label>
  );
}

/** A quiet button for the side panel's actions. */
export function PanelButton({
  children,
  onClick,
  tone = "plain",
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "plain" | "accent" | "danger";
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5",
        tone === "accent" && "bg-violet-600 text-white hover:bg-violet-500",
        tone === "plain" && "bg-zinc-900 text-zinc-200 hover:bg-zinc-800",
        tone === "danger" && "bg-zinc-900 text-red-300 hover:bg-red-950/60",
      )}
    >
      {children}
    </button>
  );
}
