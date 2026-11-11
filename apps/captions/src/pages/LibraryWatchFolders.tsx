import { useState } from "react";
import { Folder } from "lucide-react";
import type { Collection, WatchFolder, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, ListRow, Section, Status } from "@/components/settings/ui";
import { folderName, useBigFolder } from "@/components/LibraryProcessing";
import { useCachedLoad } from "@/lib/local-cache";
import { chooseFolderOnMac, thisMacBridge } from "@/lib/thisMac";

/**
 * The library's footage folders, for its owner, in the library's settings (api/library/watch.ts): folders on this
 * computer whose videos join the library by themselves, left where they are or copied in. Only when the server runs on
 * the person's computer; the page leaves the section out on a hosted server.
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
  // the saved status, read again when the library changes (a footage folder's file came in, a referenced file went missing)
  const live = useCachedLoad<WatchStatus>(`/api/library/${libraryId}/watch`, () => call(libraryId));
  const status = live.data;
  const setStatus = live.set;
  const [failed, setError] = useState<string | null>(null);
  const error = failed ?? (status ? null : live.error || null);
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<WatchFolder["mode"]>("reference");
  const [into, setInto] = useState("");
  const big = useBigFolder(); // a big folder says first what adding it takes, as from the first screen

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
  const add = () => big.check(path.trim(), () => save([...current, { path: path.trim(), mode, collectionId: into || undefined }]));
  const choose = async () => {
    const picked = await chooseFolderOnMac();
    if (picked) setPath(picked);
  };

  return (
    <Section title="Footage folders">
      <Card>
        {status?.folders.map((f) => (
          <ListRow
            key={f.path}
            icon={<Folder />}
            title={folderName(f.path)}
            subtitle={
              <span title={f.path}>
                {f.imported.toLocaleString()} {f.imported === 1 ? "clip" : "clips"} · {f.mode === "reference" ? "left where they are" : "copied in"} · {f.path}
              </span>
            }
            status={!f.found && <Status tone="attention">Not found. Plug its drive back in, or remove it here.</Status>}
            actions={
              <Button size="sm" variant="ghost" onClick={() => void save(current.filter((c) => c.path !== f.path))}>
                Remove
              </Button>
            }
          />
        ))}
        {/* clips gone from a folder that is still there (a folder not found says so on its own row) */}
        {!!status?.missing && status.folders.every((f) => f.found) && (
          <ListRow
            title={`${status.missing.toLocaleString()} ${status.missing === 1 ? "clip is" : "clips are"} not where they were`}
            status={<Status tone="attention">Their files were moved or deleted</Status>}
          />
        )}
        <form
          className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void add();
          }}
        >
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Volumes/Footage/Card dumps" aria-label="Folder path" className="min-w-0 flex-1 basis-60" />
          {thisMacBridge() && (
            <Button type="button" size="sm" variant="outline" onClick={() => void choose()}>
              Choose…
            </Button>
          )}
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
            Add folder
          </Button>
        </form>
      </Card>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {big.dialog}
    </Section>
  );
}
