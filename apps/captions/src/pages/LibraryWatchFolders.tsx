import { useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";
import type { Collection, WatchFolder, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Watch folders for the library's owner (api/library/watch.ts): folders on the server's disk whose new files come in by
 * themselves. Only when the server runs on this computer; a hosted server says so instead of showing the form.
 */

type Change = Pick<WatchFolder, "path" | "mode" | "collectionId">;

async function call(libraryId: string, folders?: Change[]): Promise<WatchStatus> {
  const r = await fetch(`/api/library/${libraryId}/watch`, {
    method: folders ? "PUT" : "GET",
    headers: folders ? { "content-type": "application/json" } : undefined,
    body: folders ? JSON.stringify({ folders }) : undefined,
  });
  const body = (await r.json().catch(() => ({}))) as WatchStatus & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body;
}

const select = "h-9 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm";

export function LibraryWatchFolders({ libraryId, folders: libraryFolders }: { libraryId: string; folders: Collection[] }) {
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<WatchFolder["mode"]>("reference");
  const [into, setInto] = useState("");

  useEffect(() => {
    call(libraryId).then(setStatus, (e: Error) => setError(e.message));
  }, [libraryId]);

  const save = async (next: Change[]) => {
    try {
      setStatus(await call(libraryId, next));
      setError(null);
      setPath("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const current = (status?.folders ?? []).map(({ path, mode, collectionId }) => ({ path, mode, collectionId }));
  const imported = status?.folders.reduce((n, f) => n + f.imported, 0) ?? 0;
  const line = status
    ? [`${status.folders.length} watch folder${status.folders.length === 1 ? "" : "s"}`, `${imported} imported`, status.missing && `${status.missing} missing`]
        .filter(Boolean)
        .join(" · ")
    : "Watch folders";

  return (
    <details className="rounded-xl border border-zinc-500/20 p-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 text-zinc-400">
        <FolderSearch className="h-4 w-4" />
        {line}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {status && !status.allowed ? (
          <p className="text-zinc-500">
            This server is not running on your computer, so it cannot see your folders. Upload the files instead. Watch folders work
            when you run Creator Toolset on your own machine.
          </p>
        ) : (
          <>
            <p className="text-zinc-500">
              A folder on the computer that runs this server. New files show up here about a minute after they stop changing. Reference
              leaves them where they are; if one goes away (moved, or the drive unplugged) it is marked missing and nothing is deleted.
            </p>
            {status?.folders.map((f) => (
              <div key={f.path} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate" title={f.path}>
                  {f.path}
                  <span className="text-zinc-500">
                    {" "}
                    · {f.mode === "reference" ? "reference" : "copy"} · {f.imported} imported{!f.found && " · not found"}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void save(current.filter((c) => c.path !== f.path))}>
                  Remove
                </Button>
              </div>
            ))}
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (path.trim()) void save([...current, { path: path.trim(), mode, collectionId: into || undefined }]);
              }}
            >
              <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Volumes/Footage/Card dumps" aria-label="Folder path" className="min-w-0 flex-1 basis-60" />
              <select aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value as WatchFolder["mode"])} className={select}>
                <option value="reference">Leave files where they are</option>
                <option value="copy">Copy into the library</option>
              </select>
              {libraryFolders.length > 0 && (
                <select aria-label="Into folder" value={into} onChange={(e) => setInto(e.target.value)} className={select}>
                  <option value="">No folder</option>
                  {libraryFolders.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              <Button type="submit" size="sm" disabled={!path.trim()}>
                Watch
              </Button>
            </form>
          </>
        )}
        {error && <p className="text-red-400">{error}</p>}
      </div>
    </details>
  );
}
