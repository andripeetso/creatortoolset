import { useCallback } from "react";
import { HardDrive } from "lucide-react";
import { ServerUpdateSection } from "./ServerUpdateSection";
import { hasTeam, useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { useProviders } from "@/lib/providers";
import type { StorageView } from "@contracts/storage";
import { devicesSectionsFor, replacementFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Section, Status, WorkspacePick, useSettingsWorkspace } from "./ui";
import { AllowedFolders, STORAGE_ALL, STORAGE_API, Storage, call, driveList, getStorage, spaceOf, isFull } from "./StorageRows";
import { KeptSection, RenderCacheSection, ThisComputerSection, WorkspaceStorageSection } from "./KeptRows";
import { ServerProjects } from "@/components/AdminPanel";
import { hasThisMac } from "./ThisMacSection";

/**
 * Settings → Folders (the Workspace group): where each workspace's finished videos and Media folders live. The
 * workspace selector starts on All workspaces (every folder, each with its workspace); one picked shows its own and
 * the ones every workspace uses. A plug-in that owns storage (`replaces.storage`) draws its own rows here for admins,
 * selector and all: only admins edit that server's folders. Under them, in the Mac app, Folder access: the folders this
 * Mac may read, the same in every workspace (the selector does not reach it; its row says "This Mac"). A member on a
 * server whose plug-in keeps the folders has that section alone, so nav.ts lists the page for them in the Mac app only.
 */
export function FoldersSection() {
  const me = useAuth((s) => s.me);
  const kept = me?.role !== "admin" && webPlugins.some((p) => !!p.replaces?.storage);
  return (
    <>
      {!kept && <Folders />}
      {hasThisMac() && <AllowedFolders />}
    </>
  );
}

/**
 * Settings → Storage (the Server group): what is not one workspace's. For an admin the server's own update, where its
 * machine runs the updater. What this account keeps on the server (in every
 * workspace), for an admin the drives of the computers, the plug-ins' own storage sections (network storage), and on a hosted server
 * every project on it (was Admin → Projects).
 */
export function StorageSection() {
  const me = useAuth((s) => s.me);
  const kind = useAuth((s) => s.kind);
  return (
    <>
      {me?.role === "admin" && <ServerUpdateSection />}
      <KeptSection />
      {me?.role === "admin" && kind !== "cloud" && <WorkspaceStorageSection />}
      <ThisComputerSection />
      {me?.role === "admin" && <RenderCacheSection />}
      {me?.role === "admin" && <Drives />}
      {me &&
        devicesSectionsFor(me, webPlugins).map((s) => (
          <Section key={s.id} title={s.title}>
            {s.body}
          </Section>
        ))}
      {hasTeam(kind) && me?.role === "admin" && <ServerProjects />}
    </>
  );
}

/** The drives of the computers a folder can go on, with the ones that are almost full named. */
function Drives() {
  const me = useAuth((s) => s.me);
  const providers = useProviders();
  const store = useCachedLoad<StorageView>("/api/devices/storage", getStorage, { own: true });
  if (!me || !providers.data || !store.data) return null;
  const own = providers.data.devices.filter((d) => d.owner === me.username || d.owner === "workspace");
  const drives = driveList(own, store.data.serverDisks);
  if (!drives.length) return null;
  return (
    <Section title="Drives">
      <Card>
        {drives.map(({ key, disk, on }) => (
          <ListRow
            key={key}
            icon={<HardDrive className="size-4" />}
            title={disk.name}
            subtitle={<>{disk.network ? "Network" : disk.path === "/" ? "Built in" : "Drive"} · {on} · {spaceOf(disk, false)}</>}
            status={isFull(disk) ? <Status tone="attention">Almost full</Status> : undefined}
          />
        ))}
      </Card>
    </Section>
  );
}

function Folders() {
  const me = useAuth((s) => s.me);
  const kind = useAuth((s) => s.kind);
  const providers = useProviders();
  const w = useSettingsWorkspace("list");
  const url = w.all ? STORAGE_ALL : STORAGE_API;
  const store = useCachedLoad<StorageView>(url, () => call<StorageView>(url, "GET", undefined, w.id), { own: true, workspace: w.cacheKey });
  const devices = providers.data?.devices ?? null;
  const storage = store.data;
  const error = providers.error || store.error;
  const refreshProviders = providers.refresh;
  const refreshStore = store.refresh;
  const load = useCallback(() => {
    void refreshProviders().catch(() => {});
    void refreshStore().catch(() => {});
  }, [refreshProviders, refreshStore]);

  // an admin's folders may be a plug-in's own store (the AI Editor's): its screen then stands in for the rows, the
  // header and the workspace selector
  const Replaced = me?.role === "admin" ? replacementFor(webPlugins, "storage") : undefined;
  const pick = Replaced ? null : <WorkspacePick mode="list" />;

  if (!me || ((!storage || !devices) && !error)) {
    return (
      <Section title="Folders">
        {pick}
        <Card>
          <LoadingRow />
        </Card>
      </Section>
    );
  }
  if (!storage || !devices) {
    return (
      <Section title="Folders">
        {pick}
        <Card>
          <ErrorRow title="Could not load folders" detail={error} retry={load} />
        </Card>
      </Section>
    );
  }

  // the computers a folder can go on: this account's own, and for an admin the team's AI worker (the server takes both)
  const own = devices.filter((d) => d.owner === me.username || (me.role === "admin" && d.owner === "workspace"));
  // a hosted member with no computer has nothing to put a folder on: said once, instead of three Add folder buttons
  if (hasTeam(kind) && own.length === 0 && storage.folders.length === 0) {
    return (
      <Section title="Folders">
        {pick}
        <Card>
          <EmptyRow title="Nothing here yet" description={<Status tone="attention">Needs a computer</Status>} />
        </Card>
      </Section>
    );
  }

  if (Replaced) return <Replaced />;
  return (
    <Section title="Folders">
      {pick}
      <Storage devices={own} storage={storage} onChanged={load} w={w} />
    </Section>
  );
}
