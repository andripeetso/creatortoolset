import { MovingBar } from "@/components/LibraryProcessing";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

/** The Media Library's uploads on their way (LibraryPage.tsx sends them one after another), with Retry and Clear finished. */

export interface Upload {
  key: number;
  file: File;
  sent: number;
  /** the manual folder open when the file was dropped: it goes in there */
  folderId?: string;
  status: "waiting" | "uploading" | "added" | "duplicate" | "failed";
  error?: string;
  inPlace?: boolean; // added where it is on this Mac, not uploaded
  final?: boolean; // refused for good (too large for this server): no Retry
}

const label = (u: Upload) =>
  u.status === "waiting"
    ? "Waiting"
    : u.status === "uploading"
    ? u.inPlace ? "Adding" : `Uploading ${Math.round((u.sent / Math.max(1, u.file.size)) * 100)}%`
    : u.status === "added"
      ? "Added"
      : u.status === "duplicate"
        ? "Already in library"
        : "Failed";

export function UploadTray({ uploads, onRetry, onClear }: { uploads: Upload[]; onRetry: (u: Upload) => void; onClear: () => void }) {
  if (!uploads.length) return null;
  return (
    <section aria-label="Uploads" className="flex flex-col gap-2 rounded-xl border border-zinc-500/20 p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{uploads.every((u) => u.inPlace) ? "Adding" : "Uploads"}</span>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear finished
        </Button>
      </div>
      {uploads.map((u) => (
        <div key={u.key} className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate">{u.file.name}</span>
            <span className="shrink-0 text-xs text-zinc-500">{label(u)}</span>
          </div>
          {/* a file added where it is has no bytes to count: its bar moves until it is in */}
          {u.status === "uploading" && (u.inPlace ? <MovingBar /> : <Progress value={(u.sent / Math.max(1, u.file.size)) * 100} className="h-1.5" />)}
          {u.status === "failed" && (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <span className="min-w-0">{u.error}</span>
              {!u.final && (
              <Button variant="outline" size="sm" onClick={() => onRetry(u)}>
                Retry
              </Button>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
