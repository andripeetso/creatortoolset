import { MovingBar } from "@/components/LibraryProcessing";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { checkUpload } from "@/lib/library";

/** The Media Library's uploads on their way (LibraryPage.tsx sends them one after another), copies into the library's folder among them, with Cancel, Cancel all, Retry and Clear finished. */

export interface Upload {
  key: number;
  file: File;
  sent: number;
  /** the manual folder open when the file was dropped: it goes in there */
  folderId?: string;
  status: "waiting" | "checking" | "copying" | "uploading" | "added" | "duplicate" | "failed" | "cancelled";
  error?: string;
  inPlace?: boolean; // added where it is on this Mac, not uploaded
  path?: string; // where it is on this Mac, known from a Finder drop (once copied: the copy's)
  copyTo?: string; // copied here first (the library's folder on this Mac), then taken in from there
  final?: boolean; // refused for good (too large for this server): no Retry
}

const label = (u: Upload) =>
  u.status === "waiting"
    ? "Waiting"
    : u.status === "checking"
    ? "Checking"
    : u.status === "copying"
    ? `Copying ${Math.round((u.sent / Math.max(1, u.file.size)) * 100)}%`
    : u.status === "uploading"
    ? u.inPlace ? "Adding" : `Uploading ${Math.round((u.sent / Math.max(1, u.file.size)) * 100)}%`
    : u.status === "added"
      ? "Added"
      : u.status === "duplicate"
        ? "Already in library"
        : u.status === "cancelled"
          ? "Cancelled"
          : "Failed";

/** Still to go or on its way: Cancel stops it. */
const going = (u: Upload) => u.status === "waiting" || u.status === "checking" || u.status === "copying" || u.status === "uploading";

export function UploadTray({ uploads, onRetry, onCancel, onClear }: { uploads: Upload[]; onRetry: (u: Upload) => void; onCancel: (keys: number[]) => void; onClear: () => void }) {
  if (!uploads.length) return null;
  const left = uploads.filter(going);
  return (
    <section aria-label="Uploads" className="flex flex-col gap-2 rounded-xl border border-zinc-500/20 p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{uploads.every((u) => u.inPlace) ? "Adding" : "Uploads"}</span>
        <div className="flex gap-1">
          {left.length > 1 && (
            <Button variant="ghost" size="sm" onClick={() => onCancel(left.map((u) => u.key))}>
              Cancel all
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear finished
          </Button>
        </div>
      </div>
      {uploads.map((u) => (
        <div key={u.key} className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate">{u.file.name}</span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
              {label(u)}
              {going(u) && (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" aria-label={`Cancel ${u.file.name}`} onClick={() => onCancel([u.key])}>
                  Cancel
                </Button>
              )}
            </span>
          </div>
          {/* a file added where it is has no bytes to count: its bar moves until it is in */}
          {/* nor one being matched with the library's clips before it goes */}
          {u.status === "checking" && <MovingBar />}
          {u.status === "copying" && <Progress value={(u.sent / Math.max(1, u.file.size)) * 100} className="h-1.5" />}
          {u.status === "uploading" && (u.inPlace ? <MovingBar /> : <Progress value={(u.sent / Math.max(1, u.file.size)) * 100} className="h-1.5" />)}
          {u.status === "cancelled" && (
            <div className="flex items-center gap-2 text-xs">
              <Button variant="outline" size="sm" onClick={() => onRetry(u)}>
                Retry
              </Button>
            </div>
          )}
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

/** A file's SHA-256 off the page's thread (hash.worker.ts): uploads go one at a time, so one worker at a time. */
function hashFile(file: File): Promise<string> {
  const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
  return new Promise<string>((ok, no) => {
    worker.onmessage = (e: MessageEvent<{ hex?: string; error?: string }>) => (e.data.hex ? ok(e.data.hex) : no(new Error(e.data.error)));
    worker.onerror = (e) => no(new Error(e.message));
    worker.postMessage(file);
  }).finally(() => worker.terminate());
}

/**
 * The clip this file already is in the library, asked before any of it is sent; null when it is new. The server is
 * asked by size first: only a file of a size it has is hashed (`onHashing` says so; a big one takes a while), and then
 * matched by the same hash an upload's finish checks. Any failure here is the caller's to ignore: the upload checks again.
 */
export async function alreadyThere(libraryId: string, file: File, onHashing: () => void): Promise<string | null> {
  if (!(await checkUpload(libraryId, file.size)).maybe) return null;
  onHashing();
  return (await checkUpload(libraryId, file.size, await hashFile(file))).duplicateOf ?? null;
}
