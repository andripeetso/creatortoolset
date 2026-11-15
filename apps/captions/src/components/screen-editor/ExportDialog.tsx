import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { clock } from "@/lib/screen-timeline";
import { exportBitrate } from "@/lib/screen-export";
import { heardTracks } from "@/lib/screen-sound";
import type { ScreenEvents, ScreenLook } from "@/lib/screen-recording";

type Size = { width: number; height: number };
type Way = { label: string; title?: string; primary?: boolean; run: () => void };

const SHAPE_NAMES: Record<ScreenLook["shape"], string> = { source: "Auto, as recorded", "16:9": "16:9, wide", "9:16": "9:16, tall", "1:1": "1:1, square", "4:5": "4:5, portrait" };
const CAMERA_NAMES = { bubble: "Bubble", side: "Beside", split: "Split", only: "Camera alone", hidden: "Hidden" } as const;

/**
 * Export's settings before the video is made: its size, and what goes into it (length, shape, format, sound, camera,
 * about how big the file gets). `ways` are where it goes (the caller's actions); the primary one is the main button.
 * `clear`: no background, so the one way out is the see-through video, at 1080p.
 */
export function ExportDialog({
  open,
  onOpenChange,
  name,
  look,
  events,
  hasCamera,
  sizes,
  uhd,
  onUhd,
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
  sizes: { hd: Size; uhd: Size };
  uhd: boolean;
  onUhd: (uhd: boolean) => void;
  /** Seconds kept after the trim, and the recording's whole length. */
  length: number;
  whole: number;
  clear: boolean;
  ways: Way[];
}) {
  const size = uhd && !clear ? sizes.uhd : sizes.hd;
  const heard = heardTracks(look, events);
  const sound = heard.voice !== null && heard.sound !== null ? "Your voice and Mac sound" : heard.voice !== null ? "Your voice" : heard.sound !== null ? "Mac sound" : "None";
  // variable bit rate: a screen that stands still comes out well under this
  const mb = Math.max(1, Math.round((exportBitrate(size.width, size.height) * length) / 8 / 1e6));
  const rows: [string, string][] = [
    ["Length", length < whole - 0.05 ? `${clock(length, true)} of ${clock(whole, true)} (trimmed)` : clock(length, true)],
    ["Shape", SHAPE_NAMES[look.shape]],
    ["Format", clear ? "MOV, ProRes 4444, transparent background" : "MP4, H.264, 60 fps"],
    ["Sound", sound],
    ...(hasCamera ? [["Camera", CAMERA_NAMES[look.camera?.layout ?? "bubble"]] as [string, string]] : []),
    ...(clear ? [] : [["File size", `up to about ${mb} MB`] as [string, string]]),
  ];
  const sorted = [...ways].sort((a, b) => Number(!!a.primary) - Number(!!b.primary));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription className="truncate text-zinc-400">{name}</DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-zinc-400">Quality</h3>
          {clear ? (
            <p className="rounded-lg bg-zinc-900 px-3 py-2.5 text-xs text-zinc-400">
              A transparent video is made at 1080p: {size.width} × {size.height}.
            </p>
          ) : (
            <div role="radiogroup" aria-label="Quality" className="grid grid-cols-2 gap-2">
              {(
                [
                  [false, "1080p", sizes.hd, "Smaller file; small text gets soft"],
                  [true, "4K", sizes.uhd, "Sharp text, as recorded on a Retina screen"],
                ] as const
              ).map(([is4k, label, s, note]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={uhd === is4k}
                  onClick={() => onUhd(is4k)}
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-left transition-colors",
                    uhd === is4k ? "border-violet-500 bg-violet-500/10" : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900",
                  )}
                >
                  <span className="block text-sm font-medium text-zinc-100">{label}</span>
                  <span className="block text-xs tabular-nums text-zinc-400">
                    {s.width} × {s.height}
                  </span>
                  <span className="mt-1 block text-[11px] text-zinc-500">{note}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-zinc-400">In the video</h3>
          <dl className="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800 text-xs">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-3 py-2">
                <dt className="text-zinc-400">{k}</dt>
                <dd className="text-right tabular-nums text-zinc-200">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11px] text-zinc-500">Change the shape above the picture; sound, camera and trim in the panel and the timeline.</p>
        </section>

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
