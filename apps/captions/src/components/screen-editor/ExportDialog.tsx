import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { clock } from "@/lib/screen-timeline";
import { exportBitrate, type ExportQuality } from "@/lib/screen-export";
import { heardTracks } from "@/lib/screen-sound";
import { outputSize, type ScreenEvents, type ScreenLook } from "@/lib/screen-recording";

type Size = { width: number; height: number };
type Way = { label: string; title?: string; primary?: boolean; run: () => void };
/** Export's own settings, kept for the next export (not in the look). `short`: pixels on the frame's short side. */
export type ExportSettings = { short: number; fps: number; quality: ExportQuality; mbps: number };

export const DEFAULT_EXPORT: ExportSettings = { short: 2160, fps: 60, quality: "high", mbps: 20 };
const RESOLUTIONS = [
  [720, "720p"],
  [1080, "1080p HD"],
  [1440, "1440p"],
  [2160, "4K UHD"],
] as const;
export const FRAME_RATES = [24, 25, 30, 50, 60] as const;
const QUALITIES: [ExportQuality, string][] = [
  ["best", "Best"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["custom", "Restrict to"],
];
const MIN_SHORT = 240;
const MAX_SHORT = 4320;

/** Settings kept from an older visit, made safe: anything unknown falls back to the default. */
export function parseExportSettings(raw: unknown): ExportSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ExportSettings, unknown>>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return {
    short: num(o.short, MIN_SHORT, MAX_SHORT, DEFAULT_EXPORT.short),
    fps: FRAME_RATES.includes(o.fps as never) ? (o.fps as number) : DEFAULT_EXPORT.fps,
    quality: QUALITIES.some(([q]) => q === o.quality) ? (o.quality as ExportQuality) : DEFAULT_EXPORT.quality,
    mbps: num(o.mbps, 1, 400, DEFAULT_EXPORT.mbps),
  };
}

const SHAPE_NAMES: Record<ScreenLook["shape"], string> = { source: "as recorded", "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", "4:5": "4:5" };
const CAMERA_NAMES = { bubble: "bubble", side: "beside", split: "split", only: "alone", hidden: "hidden" } as const;
const field =
  "h-8 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs tabular-nums text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-50";

function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
      <span className="text-xs text-zinc-400" title={title}>
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Fixed({ children }: { children: ReactNode }) {
  return <span className="text-xs text-zinc-200">{children}</span>;
}

/** A number typed in and taken on Enter or leaving the field, so a half-typed number never changes the export. */
function NumberField({ value, onCommit, label, disabled, className }: { value: number; onCommit: (v: number) => void; label: string; disabled?: boolean; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const v = Number(draft);
    if (draft !== null && draft.trim() !== "" && Number.isFinite(v) && v > 0) onCommit(v);
    setDraft(null);
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      disabled={disabled}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape" && draft !== null) {
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cn(field, "w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none", className)}
    />
  );
}

/**
 * Export's render settings, laid out like an editor's render panel: the video (format, resolution, frame rate,
 * quality) and the sound, then what goes in and about how big the file gets. `ways` are where it goes (the caller's
 * actions); the primary one is the main button. `clear`: no background, so the one way out is the see-through video,
 * at 1080p. `src` is the recording's own size: the frame's shape comes from it and the look.
 */
export function ExportDialog({
  open,
  onOpenChange,
  name,
  look,
  events,
  hasCamera,
  src,
  settings,
  onSettings,
  length,
  whole,
  clear,
  ways,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  look: ScreenLook;
  events: Pick<ScreenEvents, "audio">;
  hasCamera: boolean;
  src: Size;
  settings: ExportSettings;
  onSettings: (settings: ExportSettings) => void;
  /** Seconds kept after the trim, and the recording's whole length. */
  length: number;
  whole: number;
  clear: boolean;
  ways: Way[];
}) {
  const short = clear ? 1080 : settings.short;
  const size = outputSize(look.shape, src.width, src.height, short);
  const ratio = size.width / size.height;
  const preset = RESOLUTIONS.some(([s]) => s === short) ? String(short) : "custom";
  const set = (patch: Partial<ExportSettings>) => onSettings({ ...settings, ...patch });
  const setShort = (v: number) => set({ short: Math.min(MAX_SHORT, Math.max(MIN_SHORT, Math.round(v / 2) * 2)) });

  const heard = heardTracks(look, events);
  const sound = heard.voice !== null && heard.sound !== null ? "Voice and Mac sound" : heard.voice !== null ? "Voice" : heard.sound !== null ? "Mac sound" : null;
  const bitrate = exportBitrate(size.width, size.height, settings.fps, settings.quality, settings.mbps);
  // variable bit rate: a screen that stands still comes out well under this
  const mb = Math.max(1, Math.round((bitrate * length) / 8 / 1e6));
  const trimmed = length < whole - 0.05;
  const summary = [
    trimmed ? `${clock(length, true)} of ${clock(whole, true)}` : clock(length, true),
    `shape ${SHAPE_NAMES[look.shape]}`,
    ...(hasCamera ? [`camera ${CAMERA_NAMES[look.camera?.layout ?? "bubble"]}`] : []),
    ...(clear ? [] : [`up to about ${mb} MB`]),
  ];
  const sorted = [...ways].sort((a, b) => Number(!!a.primary) - Number(!!b.primary));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription className="truncate text-zinc-400">{name}</DialogDescription>
        </DialogHeader>

        <section className="space-y-2.5">
          <h3 className="border-b border-zinc-800 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Video</h3>
          <Row label="Format">
            <Fixed>{clear ? "QuickTime (MOV), transparent background" : "MP4"}</Fixed>
          </Row>
          <Row label="Codec">
            <Fixed>{clear ? "Apple ProRes 4444" : "H.264"}</Fixed>
          </Row>
          <Row label="Resolution">
            <select
              aria-label="Resolution"
              value={preset}
              disabled={clear}
              onChange={(e) => e.target.value !== "custom" && setShort(Number(e.target.value))}
              className={cn(field, "min-w-0 flex-1")}
            >
              {RESOLUTIONS.map(([s, label]) => (
                <option key={s} value={s}>
                  {label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
            <NumberField
              label="Width"
              disabled={clear}
              value={size.width}
              onCommit={(w) => setShort(ratio >= 1 ? w / ratio : w)}
            />
            <span className="text-xs text-zinc-500">×</span>
            <NumberField
              label="Height"
              disabled={clear}
              value={size.height}
              onCommit={(h) => setShort(ratio >= 1 ? h : h * ratio)}
            />
          </Row>
          <Row label="Frame rate" title="60 is smooth for a pointer and scrolling; fewer frames make a smaller file">
            <select
              aria-label="Frame rate"
              value={clear ? 60 : settings.fps}
              disabled={clear}
              onChange={(e) => set({ fps: Number(e.target.value) })}
              className={cn(field, "w-28")}
            >
              {FRAME_RATES.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </Row>
          {!clear && (
            <Row label="Quality" title="Bits each second: more keeps small text crisp while things move">
              <select
                aria-label="Quality"
                value={settings.quality}
                onChange={(e) => set({ quality: e.target.value as ExportQuality })}
                className={cn(field, "w-28")}
              >
                {QUALITIES.map(([q, label]) => (
                  <option key={q} value={q}>
                    {label}
                  </option>
                ))}
              </select>
              {settings.quality === "custom" ? (
                <>
                  <NumberField label="Bit rate in Mbit/s" value={settings.mbps} onCommit={(v) => set({ mbps: Math.min(400, Math.max(1, Math.round(v))) })} />
                  <span className="text-xs text-zinc-500">Mbit/s</span>
                </>
              ) : (
                <span className="text-xs tabular-nums text-zinc-500">about {Math.round(bitrate / 1e6)} Mbit/s</span>
              )}
            </Row>
          )}
        </section>

        <section className="space-y-2.5">
          <h3 className="border-b border-zinc-800 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Audio</h3>
          <Row label="Codec">
            <Fixed>{sound ? "AAC, 48 kHz, stereo" : "No sound"}</Fixed>
          </Row>
          {sound && (
            <Row label="Tracks">
              <Fixed>{sound}</Fixed>
            </Row>
          )}
        </section>

        <p className="text-[11px] tabular-nums text-zinc-500">{summary.join(" · ")}</p>

        <DialogFooter className="gap-2 sm:justify-end">
          {sorted.map((w) => (
            <Button
              key={w.label}
              title={w.title}
              variant={w.primary ? "default" : "outline"}
              onClick={w.run}
              className={cn(w.primary && "bg-violet-600 text-white hover:bg-violet-500")}
            >
              {w.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
