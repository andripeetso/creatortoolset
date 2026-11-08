import { useRef, useState } from "react";
import { Film, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { fmtBytes } from "@/lib/exports";
import { cn } from "@/lib/utils";

export type UploadItem = { video: File };

/** Review's Upload and New project: the videos are picked up front, then sent in one go. */
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
  const [rows, setRows] = useState<(UploadItem & { key: string })[]>(() =>
    (files ?? []).map((video) => ({ video, key: crypto.randomUUID() })),
  );
  const [name, setName] = useState("");
  const [over, setOver] = useState(false);
  const videoInput = useRef<HTMLInputElement>(null);

  const add = (picked: File[]) => setRows((l) => [...l, ...picked.map((video) => ({ video, key: crypto.randomUUID() }))]);

  const ready = askName ? !!name.trim() : rows.length > 0;
  const count = `${rows.length} ${rows.length === 1 ? "video" : "videos"}`;
  const start = () => ready && onStart(rows.map(({ video }) => ({ video })), name.trim());

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
        <DialogDescription className="text-zinc-500">Any video format.</DialogDescription>
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
          <span className="font-medium text-zinc-200">Drop videos here</span>
          <span className="text-xs text-zinc-500">or click to pick them</span>
        </button>

        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-sm">
            <Film className="h-4 w-4 shrink-0 text-zinc-500" />
            <span className="min-w-0 flex-1 truncate">{r.video.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-zinc-500">{fmtBytes(r.video.size)}</span>
            <button
              type="button"
              aria-label={`Remove ${r.video.name}`}
              onClick={() => setRows((l) => l.filter((x) => x.key !== r.key))}
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}

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
          accept="video/*,audio/*,.mov,.mxf,.mkv"
          multiple
          hidden
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
