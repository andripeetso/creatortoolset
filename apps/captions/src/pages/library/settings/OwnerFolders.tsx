import { Fragment, useState } from "react";
import { EVERY_WORKSPACE, FOLDER_LABELS, type AddFolderBody, type StorageFolder, type StorageView } from "@contracts/storage";
import { LIBRARY_WORDS, type LibrarySummary } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useCachedLoad } from "@/lib/local-cache";
import { useProviders } from "@/lib/providers";
import { updateLibrary } from "@/lib/library";
import { AddFolderDialog, FolderRow, STORAGE_API, call } from "@/components/settings/StorageRows";
import { Card, ErrorRow, LoadingRow, Row, Status } from "@/components/settings/ui";

type Role = AddFolderBody["role"];
/** The rows in the order the page shows them: Source media, Project files, Final exports. */
const ROLES: readonly Role[] = ["footage", "projects", "library"];
const TIPS: Record<Role, string> = { footage: LIBRARY_WORDS.sourceMediaTip, projects: LIBRARY_WORDS.projectFilesTip, library: LIBRARY_WORDS.finalExportsTip };

/**
 * The workspace's folder rows (UNIFIED-PRD §3.1 Folders): the one folder list of Settings → Folders, for this workspace
 * (the folder records of every computer). `defaultFolders` (the owner's switch) on: the three folders are rows and not
 * changed here; off: a folder not chosen yet shows "Not set" and Set…. The rows and their menu are StorageRows' own.
 */
export function OwnerFolders({ library, workspace, onChange, onError }: { library: LibrarySummary; workspace: string | null; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const providers = useProviders();
  const store = useCachedLoad<StorageView>(STORAGE_API, () => call<StorageView>(STORAGE_API, "GET", undefined, workspace), { own: true, workspace: workspace ?? undefined });
  const [adding, setAdding] = useState<Role | null>(null);
  const defaults = library.settings.defaultFolders !== false;
  const refresh = () => {
    void store.refresh().catch(() => {});
    void providers.refresh().catch(() => {});
  };
  const setDefaults = (on: boolean) =>
    updateLibrary(library.id, { settings: { defaultFolders: on } })
      .then(onChange)
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  if (!store.data) return <Card>{store.error ? <ErrorRow title="Could not load folders" retry={refresh} /> : <LoadingRow />}</Card>;

  const devices = providers.data?.devices ?? [];
  const inWorkspace = (f: StorageFolder) => !workspace || f.workspace === EVERY_WORKSPACE || f.workspace === workspace || !!f.workspaces?.includes(workspace);
  const folders = store.data.folders.filter(inWorkspace);
  const sources = folders.filter((f) => f.role === "footage");
  // a Project files or Final exports folder inside a Source media folder on the same computer is not footage
  const inside = (f: StorageFolder) => sources.some((s) => s.origin.host === f.origin.host && f.origin.path.startsWith(`${s.origin.path.replace(/\/$/, "")}/`));

  return (
    <Card>
      <Row
        title={LIBRARY_WORDS.defaultFolders.label}
        tip={LIBRARY_WORDS.defaultFolders.tip}
        control={<Switch aria-label={LIBRARY_WORDS.defaultFolders.label} checked={defaults} onCheckedChange={(on) => void setDefaults(on)} />}
      />
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
                role === "footage" ? (
                  <Button size="sm" variant="outline" onClick={() => setAdding(role)}>
                    {LIBRARY_WORDS.addFolder}
                  </Button>
                ) : none && !defaults ? (
                  <Button size="sm" variant="outline" onClick={() => setAdding(role)}>
                    {LIBRARY_WORDS.setFolder}
                  </Button>
                ) : undefined
              }
            />
            {mine.map((f) => (
              <FolderRow key={f.id} folder={f} devices={devices} onChanged={refresh} />
            ))}
          </Fragment>
        );
      })}
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
