import { useEffect, useRef, useState } from "react";
import { FileText, Film, Plus, TriangleAlert, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { fmtBytes } from "@/lib/exports";
import { timecode } from "@/lib/review";
import { cn } from "@/lib/utils";
import {
  importTimeline,
  isTimelineFile,
  MAX_TIMELINE_BYTES,
  TIMELINE_ACCEPT,
  TimelineError,
} from "@contracts/timeline-import";

export type UploadItem = { video: File; timeline?: File };

const stem = (f: File) => f.name.replace(/\.[^.]+$/, "").toLowerCase();

/** Videos with their timeline files: the one named like the video, else the
 *  only one with the only video still without one. `lone` = no video for it. */
export function pairFiles(files: File[], items: UploadItem[] = []): { items: UploadItem[]; lone: File[] } {
  const all = [
    ...items.map((x) => ({ ...x })),
    ...files.filter((f) => !isTimelineFile(f.name)).map((video): UploadItem => ({ video })),
  ];
  const timelines = files.filter((f) => isTimelineFile(f.name));
  const lone: File[] = [];
  for (const t of timelines) {
    const open = all.filter((x) => !x.timeline);
    const to = open.find((x) => stem(x.video) === stem(t)) ?? (open.length === 1 && timelines.length === 1 ? open[0] : undefined);
    if (to) to.timeline = t;
    else lone.push(t);
  }
  return { items: all, lone };
}

/** Seconds, when this browser can read the file (not ProRes in Chrome). */
const videoSeconds = (f: File) =>
  new Promise<number | undefined>((done) => {
    const v = document.createElement("video");
    const end = (s?: number) => {
      URL.revokeObjectURL(v.src);
      done(s);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => end(Number.isFinite(v.duration) ? v.duration : undefined);
    v.onerror = () => end();
    v.src = URL.createObjectURL(f);
  });

type Check = { seconds?: number; summary?: string; error?: string };

/** The server reads it the same way on upload (api/review.ts), this just says so first. */
async function checkTimeline(f: File): Promise<Check> {
  if (f.size > MAX_TIMELINE_BYTES) return { error: "That timeline file is too big" };
  try {
    const t = importTimeline(f.name, await f.text());
    const seconds = t.duration / t.fps;
    const tracks = `${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"}`;
    return { seconds, summary: `${tracks} · ${timecode(seconds, 0)} at ${+t.fps.toFixed(3)} fps` };
  } catch (e) {
    return { error: e instanceof TimelineError ? e.message : `Couldn't read ${f.name}` };
  }
}

type Row = UploadItem & { key: string; seconds?: number; check?: Check };

/** Review's Upload and New project (owner, 2026-09-30: a timeline file is picked
 *  with its video up front, not found later under the player). */
export function ReviewUploadDialog({
  title,
  files,
  askName,
  onClose,
  onStart,
}: {
  title: string;
  /** Dropped on the page. */
  files?: File[];
  /** New project: its name first. */
  askName?: boolean;
  onClose: () => void;
  onStart: (items: UploadItem[], name: string) => void;
}) {
  // the files dropped on the page, if any
  const [first] = useState(() => pairFiles(files ?? []));
  const [rows, setRows] = useState<Row[]>(() => first.items.map((x) => ({ ...x, key: crypto.randomUUID() })));
  const [lone, setLone] = useState(() => first.lone.map((t) => t.name));
  const [name, setName] = useState("");
  const [over, setOver] = useState(false);
  const videoInput = useRef<HTMLInputElement>(null);
  const timelineInput = useRef<HTMLInputElement>(null);
  const timelineFor = useRef("");

  const update = (key: string, patch: Partial<Row>) =>
    setRows((l) => l.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const measure = (r: Row, old?: Row) => {
    if (!old) void videoSeconds(r.video).then((seconds) => update(r.key, { seconds }));
    if (r.timeline && r.timeline !== old?.timeline) void checkTimeline(r.timeline).then((check) => update(r.key, { check }));
  };
  const add = (files: File[]) => {
    const paired = pairFiles(files, rows);
    const next = paired.items.map((x, i): Row => ({ ...rows[i], ...x, key: rows[i]?.key ?? crypto.randomUUID() }));
    next.forEach((r, i) => measure(r, rows[i]));
    setRows(next);
    setLone(paired.lone.map((t) => t.name));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the files dropped on the page
  useEffect(() => rows.forEach((r) => measure(r)), []);

  const setTimeline = (key: string, timeline?: File) => {
    const r = rows.find((x) => x.key === key);
    if (!r) return;
    update(key, { timeline, check: undefined });
    measure({ ...r, timeline }, r);
  };

  const bad = rows.some((r) => r.check?.error);
  const ready = !bad && (askName ? !!name.trim() : rows.length > 0);
  const count = `${rows.length} ${rows.length === 1 ? "video" : "videos"}`;
  const start = () => ready && onStart(rows.map(({ video, timeline }) => ({ video, timeline })), name.trim());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-xl"
        // the page behind uploads what's dropped on it: this one's own
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          add([...e.dataTransfer.files]);
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="text-zinc-500">
          Any video format. Add each one's timeline file (OTIO, XML, FCPXML or EDL from Resolve, Premiere or Final
          Cut) and its tracks show under the player, so comments can point at a clip.
        </DialogDescription>
        {askName && (
          <input
            autoFocus
            value={name}
            maxLength={120}
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start()}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-violet-500"
          />
        )}
        <button
          type="button"
          onClick={() => videoInput.current?.click()}
          className={cn(
            "flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center text-sm hover:border-violet-500/60",
            over ? "border-violet-500 bg-violet-950/30" : "border-zinc-800",
          )}
        >
          <UploadCloud className="h-6 w-6 text-zinc-500" />
          <span className="font-medium text-zinc-200">Drop videos and their timeline files here</span>
          <span className="text-xs text-zinc-500">or click to pick them</span>
        </button>

        {rows.map((r) => {
          const off = r.seconds && r.check?.seconds && Math.abs(r.check.seconds - r.seconds) > 1;
          return (
            <div key={r.key} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-sm">
              <div className="flex items-center gap-2">
                <Film className="h-4 w-4 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1 truncate">{r.video.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                  {r.seconds ? `${timecode(r.seconds, 0)} · ` : ""}
                  {fmtBytes(r.video.size)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${r.video.name}`}
                  onClick={() => setRows((l) => l.filter((x) => x.key !== r.key))}
                  className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-2 pl-6 text-xs">
                {r.timeline ? (
                  <>
                    <FileText className={cn("h-3.5 w-3.5 shrink-0", r.check?.error ? "text-red-400" : "text-violet-300")} />
                    <span className="min-w-0 truncate text-zinc-300">{r.timeline.name}</span>
                    <span className={cn("min-w-0 flex-1 truncate", r.check?.error ? "text-red-400" : "text-zinc-500")}>
                      {r.check ? (r.check.error ?? r.check.summary) : "Reading…"}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove the timeline file"
                      onClick={() => setTimeline(r.key)}
                      className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      timelineFor.current = r.key;
                      timelineInput.current?.click();
                    }}
                    className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-zinc-300 hover:border-violet-500/60 hover:text-zinc-100"
                  >
                    <Plus className="h-3.5 w-3.5" /> Timeline file <span className="text-zinc-500">(optional)</span>
                  </button>
                )}
              </div>
              {off && (
                <p className="mt-1.5 flex items-start gap-1.5 pl-6 text-xs text-amber-300">
                  <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                  The timeline runs {timecode(r.check!.seconds!, 0)}, the video {timecode(r.seconds!, 0)}. Is it this
                  video's? It lines up only with a render of the whole timeline.
                </p>
              )}
            </div>
          );
        })}
        {lone.length > 0 && (
          <p className="text-xs text-red-400">
            {lone.join(", ")}: which video is it for? Use Timeline file on that video's row.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} className="border-zinc-800 bg-transparent">
            Cancel
          </Button>
          <Button disabled={!ready} onClick={start} className="bg-violet-600 text-white hover:bg-violet-500">
            {askName ? (rows.length ? `Create and upload ${count}` : "Create project") : rows.length ? `Upload ${count}` : "Upload"}
          </Button>
        </div>

        <input
          ref={videoInput}
          type="file"
          accept={`video/*,audio/*,.mov,.mxf,.mkv,${TIMELINE_ACCEPT}`}
          multiple
          hidden
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <input
          ref={timelineInput}
          type="file"
          accept={TIMELINE_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setTimeline(timelineFor.current, f);
            e.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
