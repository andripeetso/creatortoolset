import { Check } from "lucide-react";
import { useStudio } from "@/lib/store";
import { STYLE_PRESETS, fontWeightFor } from "@/lib/types";

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-zinc-500">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(e) => onChange(Number(e.currentTarget.value))}
        className="h-2 w-full accent-violet-500"
      />
    </div>
  );
}

/**
 * Bottom sheet with the desktop style presets (swipe row) plus the two
 * sliders that matter on mobile: caption size and vertical position.
 */
export function MobileStyleSheet({ onClose }: { onClose: () => void }) {
  const style = useStudio((s) => s.style);
  const setStyle = useStudio((s) => s.setStyle);
  const applyPreset = useStudio((s) => s.applyPreset);
  const activePreset = useStudio((s) => s.activePreset);

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="pb-safe absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-zinc-700/60 bg-[#16161c] px-4 pb-4 pt-2">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-700" />
        <p className="mb-3 text-sm font-semibold text-zinc-100">Caption style</p>

        <div className="-mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-1">
          {STYLE_PRESETS.map((p) => {
            const active = activePreset === p.name;
            return (
              <button
                key={p.name}
                onClick={() => applyPreset(p.name, p.style)}
                className={`w-28 shrink-0 snap-start rounded-xl border p-3 text-left transition-colors ${
                  active
                    ? "border-violet-500 bg-violet-500/10"
                    : "border-zinc-700/70 bg-zinc-900/60 active:bg-zinc-800"
                }`}
              >
                <span
                  className="block text-lg leading-6"
                  style={{
                    fontFamily: `"${p.style.fontFamily}"`,
                    fontWeight: fontWeightFor(p.style.fontFamily),
                    color: p.style.textColor,
                    textTransform: p.style.uppercase ? "uppercase" : "none",
                    textShadow: p.style.boxEnabled
                      ? "none"
                      : "1px 1px 0 #000, -1px 1px 0 #000, 1px -1px 0 #000, -1px -1px 0 #000",
                    background: p.style.boxEnabled
                      ? p.style.boxColor
                      : "transparent",
                    borderRadius: 4,
                    padding: p.style.boxEnabled ? "0 4px" : 0,
                    display: "inline-block",
                  }}
                >
                  Aa
                </span>
                <span className="mt-1.5 flex items-center gap-1 text-[11px] text-zinc-400">
                  {active && <Check className="h-3 w-3 text-violet-400" />}
                  {p.name}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-col gap-4">
          <Slider
            label="Caption size"
            value={style.fontSizePct}
            min={1.5}
            max={8}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={(v) => setStyle({ fontSizePct: v })}
          />
          <Slider
            label="Vertical position"
            value={style.boxY}
            min={20}
            max={95}
            step={0.5}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => setStyle({ boxY: v })}
          />
        </div>
      </div>
    </div>
  );
}
