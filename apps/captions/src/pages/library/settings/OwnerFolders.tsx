import { Fragment, useEffect, useState } from "react";
import { EVERY_WORKSPACE, FOLDER_LABELS, type AddFolderBody, type StorageFolder, type StorageView } from "@contracts/storage";
import { LIBRARY_WORDS, levelOf, type LibrarySummary, type WatchStatus } from "@contracts/library";
import { aboutUsd } from "@/components/LibraryProcessing";
import { Button } from "@/components/ui/button";
import { useCachedLoad } from "@/lib/local-cache";
import { useProviders } from "@/lib/providers";
import { getEstimate, getWatch, updateLibrary, useLibraryChanges } from "@/lib/library";
import { AddFolderDialog, FolderRow, STORAGE_API, call, removeStorageFolder } from "@/components/settings/StorageRows";
import { thisMacDevice } from "@/lib/providers";
import { importMake, type PickedFolder } from "@/lib/thisMac";
import { LibraryFolderBox, layoutIn, missingIn } from "./LibraryFolder";
import { Card, ErrorRow, LoadingRow, Row, Status } from "@/components/settings/ui";

type Role = AddFolderBody["role"];
/** The rows in the order the page shows them: Source media, Project files, Final exports. */
const ROLES: readonly Role[] = ["footage", "projects", "library"];
const TIPS: Record<Role, string> = { footage: LIBRARY_WORDS.sourceMediaTip, projects: LIBRARY_WORDS.projectFilesTip, library: LIBRARY_WORDS.finalExportsTip };

/**
 * The workspace's folder rows (UNIFIED-PRD §3.1 Folders): the one folder list of Settings → Folders, for this workspace
 * (the folder records of every computer), in setup's own box (./LibraryFolder.tsx, 11-19 sign-off D1): the Library
 * folder the three are in, Change… picks another (its Source media, Project files and Final exports found there or made,
 * and added as rows); under it the three in a summary, and ⋯ unrolls them into their rows, each with Set…, Add folder…
 * or its menu (StorageRows' own). A folder still being indexed says so under the box, folded or not.
 */
export function OwnerFolders({ library, workspace, onChange, onError }: { library: LibrarySummary; workspace: string | null; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const providers = useProviders();
  const store = useCachedLoad<StorageView>(STORAGE_API, () => call<StorageView>(STORAGE_API, "GET", undefined, workspace), { own: true, workspace: workspace ?? undefined });
  const [adding, setAdding] = useState<Role | null>(null);
  const [unrolled, setUnrolled] = useState(false);
  // the folders this server reads, with how many files each still has to take in (a folder added indexes at once)
  const watch = useCachedLoad<WatchStatus>(`/api/library/${library.id}/watch`, () => getWatch(library.id));
  useLibraryChanges(() => void watch.refresh().catch(() => {}));
  const defaults = library.settings.defaultFolders !== false;
  const refresh = () => {
    void store.refresh().catch(() => {});
    void providers.refresh().catch(() => {});
  };
  const setDefaults = (on: boolean) =>
    updateLibrary(library.id, { settings: { defaultFolders: on } })
      .then(onChange)
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  // another Library folder: its missing folders made on this Mac, then the three as this workspace's rows (Project files
  // and Final exports take the place of the ones it had; Source media is added)
  const moveTo = async (picked: PickedFolder) => {
    try {
      const host = store.data?.here?.[0] ?? thisMacDevice();
      if (!host) throw new Error(LIBRARY_WORDS.folderInMacApp);
      // a Mac app from before has no such ask (and sends no names): the first copy into them makes them
      if (picked.children) await importMake(picked.path, missingIn(picked.children)).catch((e: unknown) => {
        if (!/latest Mac app|Not an import/i.test(e instanceof Error ? e.message : String(e))) throw e;
      });
      for (const l of layoutIn(picked.path, picked.children)) await call(`${STORAGE_API}/folders`, "POST", { role: l.use, host, path: l.path }, workspace ?? undefined).catch((e: unknown) => {
        if (!/already/i.test(e instanceof Error ? e.message : String(e))) throw e;
      });
      refresh();
      if (!defaults) await setDefaults(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  if (!store.data) return <Card>{store.error ? <ErrorRow title="Could not load folders" retry={refresh} /> : <LoadingRow />}</Card>;

  const devices = providers.data?.devices ?? [];
  const inWorkspace = (f: StorageFolder) => !workspace || f.workspace === EVERY_WORKSPACE || f.workspace === workspace || !!f.workspaces?.includes(workspace);
  const folders = store.data.folders.filter(inWorkspace);
  const sources = folders.filter((f) => f.role === "footage");
  // a Project files or Final exports folder inside a Source media folder on the same computer is not footage
  const inside = (f: StorageFolder) => sources.some((s) => s.origin.host === f.origin.host && f.origin.path.startsWith(`${s.origin.path.replace(/\/$/, "")}/`));
  // the folder the three are in, when they are all in one (else none to name: Custom, or Not set before any is made)
  const parent = (f?: StorageFolder) => f?.origin.path.replace(/\/[^/]*\/?$/, "");
  const three = ROLES.map((role) => folders.find((f) => f.role === role));
  const base = three.every((f) => f && f.origin.host === three[0]!.origin.host && parent(f) === parent(three[0])) ? parent(three[0]) : undefined;

  // the folders still being indexed, under the box in both its states
  const indexing = sources.flatMap((f) => {
    const w = watch.data?.folders.find((x) => x.path === f.origin.path && x.adding > 0);
    return w ? [{ f, count: w.adding }] : [];
  });
  const nameOf = (f: StorageFolder) => (base && parent(f) === base ? f.name : f.origin.path);

  return (
    <Card>
      <LibraryFolderBox
        path={base}
        onPick={(p) => void moveTo(p)}
        head={base ? LIBRARY_WORDS.foldersInIt : LIBRARY_WORDS.foldersInUse}
        lines={ROLES.map((role) => {
          const mine = folders.filter((f) => f.role === role);
          return { use: role as "footage" | "projects" | "library", folder: mine.length ? mine.map(nameOf).join(", ") : LIBRARY_WORDS.notSet };
        })}
        open={unrolled}
        onToggle={() => setUnrolled((o) => !o)}
        below={indexing.map(({ f, count }) => (
          <IndexingLine
            key={f.id}
            libraryId={library.id}
            path={f.origin.path}
            count={count}
            off={levelOf(library.settings) === "off"}
            onCancel={() => void removeStorageFolder(f.id).then(refresh, (e: unknown) => onError(e instanceof Error ? e.message : String(e)))}
          />
        ))}
      >
        {ROLES.map((role) => {
          const mine = folders.filter((f) => f.role === role);
          const none = mine.length === 0;
          const nested = mine.some(inside);
          return (
            <Fragment key={role}>
              <Row
                title={FOLDER_LABELS[role]}
                tip={TIPS[role]}
                status={
                  none ? (
                    <Status tone="attention">{LIBRARY_WORDS.notSet}</Status>
                  ) : nested ? (
                    <Status>{LIBRARY_WORDS.insideSourceMedia}</Status>
                  ) : undefined
                }
                control={
                  // a folder not set yet: Set…; Source media: Add folder… for one more. A set one is changed from its own menu
                  none ? (
                    <Button size="sm" variant="outline" onClick={() => setAdding(role)}>
                      {LIBRARY_WORDS.setFolder}
                    </Button>
                  ) : role === "footage" ? (
                    <Button size="sm" variant="outline" onClick={() => setAdding(role)}>
                      {LIBRARY_WORDS.addFolder}
                    </Button>
                  ) : undefined
                }
              />
              {mine.map((f) => (
                // Source media stays changeable (the folders added); the default Project files and Final exports rows are fixed while all three are the Library folder's
                <FolderRow key={f.id} folder={f} devices={devices} onChanged={refresh} locked={defaults && role !== "footage"} />
              ))}
            </Fragment>
          );
        })}
      </LibraryFolderBox>
      {adding && (
        <AddFolderDialog
          open
          onOpenChange={(o) => !o && setAdding(null)}
          role={adding}
          devices={devices}
          serverDisks={store.data.serverDisks}
          here={store.data.here}
          onChanged={refresh}
        />
      )}
    </Card>
  );
}

/**
 * A folder still being indexed (11-19: a folder is added at once, nothing asks first): "Indexing 312 clips · about $40 ·
 * Cancel". The cost is the total of what is left, at this library's settings (api/library/estimate.ts), none at Effort
 * Off. Cancel takes the folder off the list, which stops its indexing; the clips already in stay.
 */
function IndexingLine({ libraryId, path, count, off, onCancel }: { libraryId: string; path: string; count: number; off: boolean; onCancel: () => void }) {
  const [usd, setUsd] = useState<number | null>(null);
  useEffect(() => {
    if (off) return setUsd(null);
    let live = true;
    // the folder's bytes, for its share still to go (what the estimate's time and money are counted from)
    void fetch(`/api/library/${libraryId}/watch/size?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ files: number; bytes: number }>) : null))
      .catch(() => null)
      .then((size) => getEstimate(libraryId, { clips: count, bytes: size?.files ? (size.bytes * count) / size.files : 0 }))
      .then((e) => live && setUsd(e.steps.reduce((n, x) => n + x.usd, 0)), () => {});
    return () => {
      live = false;
    };
  }, [libraryId, path, count, off]);
  return (
    <p className="flex items-center gap-1.5 px-8 pb-2 text-xs text-muted-foreground sm:px-10">
      <span>{`Indexing ${count.toLocaleString()} ${count === 1 ? "clip" : "clips"}${!off && usd ? ` · ${aboutUsd(usd)}` : ""}`}</span>
      <span aria-hidden>·</span>
      <button type="button" className="underline-offset-4 hover:underline" onClick={onCancel}>
        Cancel
      </button>
    </p>
  );
}
