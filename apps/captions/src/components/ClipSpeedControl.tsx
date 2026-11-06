import { useEffect, useRef, useState } from "react";
import {
  CLIP_SPEEDS,
  formatClipSpeed,
  type ClipSpeed,
} from "@/lib/clip-playback";
import { cn } from "@/lib/utils";

export function ClipSpeedControl({
  rate,
  onChange,
  className,
}: {
  rate: ClipSpeed;
  onChange: (rate: ClipSpeed) => void;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title="Playback speed"
        aria-label={`Playback speed ${formatClipSpeed(rate)}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "rounded px-1.5 py-1 font-mono text-[11px] tabular-nums hover:bg-white/10",
          className,
        )}
      >
        {formatClipSpeed(rate)}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Playback speed"
          className="absolute bottom-full right-0 z-10 mb-1.5 min-w-[4.75rem] overflow-hidden rounded-lg border border-white/10 bg-black/90 py-1 shadow-xl backdrop-blur-sm"
        >
          {CLIP_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={s === rate}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(s);
                setOpen(false);
              }}
              className={cn(
                "flex w-full px-3 py-1.5 font-mono text-[11px] tabular-nums",
                s === rate
                  ? "bg-violet-500/30 text-white"
                  : "text-white/70 hover:bg-white/10 hover:text-white",
              )}
            >
              {formatClipSpeed(s)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
