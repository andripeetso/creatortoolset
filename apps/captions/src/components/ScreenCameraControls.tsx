import { cn } from "@/lib/utils";
import { defaultCamera, type CameraLook, type ScreenLook } from "@/lib/screen-recording";

const LAYOUTS: { id: CameraLook["layout"]; label: string }[] = [
  { id: "bubble", label: "Bubble" },
  { id: "only", label: "Camera only" },
  { id: "side", label: "Side by side" },
  { id: "hidden", label: "Hidden" },
];

const CORNERS: { id: CameraLook["corner"]; label: string }[] = [
  { id: "tl", label: "Top left" },
  { id: "tr", label: "Top right" },
  { id: "bl", label: "Bottom left" },
  { id: "br", label: "Bottom right" },
];

const SHAPES: { id: CameraLook["shape"]; label: string }[] = [
  { id: "circle", label: "Circle" },
  { id: "rounded", label: "Rounded" },
];

/** The camera section of the screen recording editor's sidebar: layout, bubble size, corner, shape, mirror. */
export function CameraControls({ look, onChange }: { look: ScreenLook; onChange: (look: ScreenLook) => void }) {
  const cam = look.camera ?? defaultCamera();
  const set = (patch: Partial<CameraLook>) => onChange({ ...look, camera: { ...cam, ...patch } });

  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Camera</h3>
      <div className="flex flex-wrap gap-1">
        {LAYOUTS.map((l) => (
          <button
            key={l.id}
            onClick={() => set({ layout: l.id })}
            className={cn("rounded px-2 py-1 text-xs", cam.layout === l.id ? "bg-violet-600 text-white" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800")}
          >
            {l.label}
          </button>
        ))}
      </div>
      {cam.layout === "bubble" && (
        <>
          <label className="block">
            <span className="flex justify-between text-xs text-zinc-400">
              Size <span className="tabular-nums text-zinc-500">{Math.round(cam.size * 100)}</span>
            </span>
            <input
              type="range"
              className="w-full accent-violet-500"
              value={cam.size}
              min={0.12}
              max={0.4}
              step={0.01}
              onChange={(e) => set({ size: Number(e.target.value) })}
            />
          </label>
          <div className="flex gap-1">
            {CORNERS.map((c) => (
              <button
                key={c.id}
                onClick={() => set({ corner: c.id })}
                aria-label={c.label}
                title={c.label}
                className={cn("h-7 w-7 rounded text-[10px]", cam.corner === c.id ? "bg-violet-600 text-white" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800")}
              >
                {c.id.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                onClick={() => set({ shape: s.id })}
                className={cn("rounded px-2 py-1 text-xs", cam.shape === s.id ? "bg-violet-600 text-white" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800")}
              >
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}
      <label className="flex items-center justify-between gap-2 text-xs text-zinc-300">
        Mirror
        <input type="checkbox" className="accent-violet-500" checked={cam.mirror} onChange={(e) => set({ mirror: e.target.checked })} />
      </label>
    </section>
  );
}
