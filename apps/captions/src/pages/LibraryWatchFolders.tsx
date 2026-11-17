import { useState } from "react";
import { Folder } from "lucide-react";
import type { Collection, LibrarySummary, WatchFolder, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, ErrorRow, ListRow, Section, SettingsSelect, Status } from "@/components/settings/ui";
import { folderName, useBigFolder } from "@/components/LibraryProcessing";
import { useCachedLoad } from "@/lib/local-cache";
import { chooseFolderOnMac, thisMacBridge } from "@/lib/thisMac";

/**
 * The library's footage folders, for its owner, in the library's own settings sheet (api/library/watch.ts): folders on
 * this computer whose videos are added to the library as they come, kept in place or copied into the Library's Footage
 * folder there (status.copyTo; a library whose originals are in a bucket copies them in instead). Only when the server
 * runs on the person's computer; the sheet leaves the section out on a hosted server, and Settings → Media Library
 * leaves it to Settings → Folders.
 */

type Change = Pick<WatchFolder, "path" | "mode" | "collectionId" | "copyTo">;

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

/** The add form's "no folder" (the kit's select takes no empty value). */
const NONE = "none";

export function LibraryWatchFolders({
  libraryId,
  folders: libraryFolders,
  onOrganized,
}: {
  libraryId: string;
  folders: Collection[];
  /** a big folder's offer to organize the library was answered (useBigFolder) */
  onOrganized?: (l: LibrarySummary) => void;
}) {
  // the saved status, read again when the library changes (a footage folder's file came in, a referenced file went missing)
  const live = useCachedLoad<WatchStatus>(`/api/library/${libraryId}/watch`, () => call(libraryId));
  const status = live.data;
  const setStatus = live.set;
  const [failed, setError] = useState<string | null>(null);
  const error = failed ?? (status ? null : live.error || null);
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<WatchFolder["mode"]>("reference");
  const [into, setInto] = useState("");
  const big = useBigFolder(onOrganized); // a big folder says first what adding it takes, as from the first screen

  const save = async (next: Change[]) => {
    try {
      setStatus(await call(libraryId, next));
      setError(null);
      setPath("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const current = (status?.folders ?? []).map(({ path, mode, collectionId, copyTo }) => ({ path, mode, collectionId, copyTo }));
  // where the server can copy into a folder on this computer, the one dialog asks copy or keep, as everywhere else
  const add = () =>
    big.check(path.trim(), (copyTo) =>
      save([...current, { path: path.trim(), collectionId: into || undefined, ...(copyTo ? { mode: "reference", copyTo } : { mode: status?.copyTo ? "reference" : mode }) }]),
      { libraryId, offerCopy: true },
    );
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
                {f.imported.toLocaleString()} {f.imported === 1 ? "clip" : "clips"} ·{" "}
                {f.copyTo ? `copied to ${f.copyTo}/${folderName(f.path)}` : f.mode === "reference" ? "kept in place" : "copied into the library"} · {f.path}
              </span>
            }
            status={!f.found && <Status tone="attention">Not found</Status>}
            actions={
              <Button size="sm" variant="ghost" onClick={() => void save(current.filter((c) => c.path !== f.path))}>
                Remove
              </Button>
            }
          />
        ))}
        {/* clips missing from a folder that is still there (a folder not found says so on its own row) */}
        {!!status?.missing && status.folders.every((f) => f.found) && (
          <ListRow title={`${status.missing.toLocaleString()} ${status.missing === 1 ? "clip" : "clips"} missing`} status={<Status tone="attention">Files moved or deleted</Status>} />
        )}
        <form
          className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void add();
          }}
        >
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Folder path" aria-label="Folder path" required className="h-8 min-w-0 flex-1 basis-60" />
          {thisMacBridge() && (
            <Button type="button" size="sm" variant="outline" onClick={() => void choose()}>
              Choose…
            </Button>
          )}
          {!status?.copyTo && (
            <SettingsSelect
              label="Import"
              value={mode}
              onValueChange={(v) => setMode(v as typeof mode)}
              options={[
                { value: "reference", label: "Keep in place" },
                { value: "copy", label: "Copy into the library" },
              ]}
              className="sm:w-auto"
            />
          )}
          {libraryFolders.length > 0 && (
            <SettingsSelect label="Library folder" value={into || NONE} onValueChange={(v) => setInto(v === NONE ? "" : v)} options={[{ value: NONE, label: "No folder" }, ...libraryFolders.map((c) => ({ value: c.id, label: c.name }))]} className="sm:w-auto" />
          )}
          <Button type="submit" size="sm">
            Add
          </Button>
        </form>
        {error && <ErrorRow title={error} />}
      </Card>
      {big.dialog}
    </Section>
  );
}
