import { useCallback } from "react";
import { HardDrive } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { useProviders } from "@/lib/providers";
import type { StorageView } from "@contracts/storage";
import { devicesSectionsFor, replacementFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Section, Status } from "./ui";
import { AddStorageButton, Storage, driveList, getStorage, spaceOf, isFull } from "./StorageRows";
import { KeptSection } from "./KeptRows";
import { ServerProjects } from "@/components/AdminPanel";

/**
 * Settings → Folders (the Workspace group): where a workspace's finished videos, footage and music live, one row each.
 * A plug-in that owns storage (`replaces.storage`) draws its own rows here for admins; a member there has no Folders
 * page (nav.ts sectionsFor: only admins edit that server's folders).
 */
export function FoldersSection() {
  return <Folders />;
}

/**
 * Settings → Storage (the Server group): what is not one workspace's. What this account keeps on the server, for an
 * admin the drives of the computers, the plug-ins' own storage sections (network storage), and on a hosted server
 * every project on it (was Admin → Projects).
 */
export function StorageSection() {
  const me = useAuth((s) => s.me);
  const hosted = useAuth((s) => s.hosted);
  return (
    <>
      <KeptSection />
      {me?.role === "admin" && <Drives />}
      {me &&
        devicesSectionsFor(me, webPlugins).map((s) => (
          <Section key={s.id} title={s.title}>
            {s.body}
          </Section>
        ))}
      {hosted && me?.role === "admin" && <ServerProjects />}
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
            subtitle={<>{disk.network ? "Network" : disk.path === "/" ? "Built in" : "Drive"} · {on} · {spaceOf(disk)}</>}
            status={isFull(disk) ? <Status tone="attention">Almost full</Status> : undefined}
          />
        ))}
      </Card>
    </Section>
  );
}

function Folders() {
  const me = useAuth((s) => s.me);
  const hosted = useAuth((s) => s.hosted);
  const providers = useProviders();
  const store = useCachedLoad<StorageView>("/api/devices/storage", getStorage, { own: true });
  const devices = providers.data?.devices ?? null;
  const storage = store.data;
  const error = providers.error || store.error;
  const refreshProviders = providers.refresh;
  const refreshStore = store.refresh;
  const load = useCallback(() => {
    void refreshProviders().catch(() => {});
    void refreshStore().catch(() => {});
  }, [refreshProviders, refreshStore]);

  if (!me || ((!storage || !devices) && !error)) {
    return (
      <Section title="Folders">
        <Card>
          <LoadingRow />
        </Card>
      </Section>
    );
  }
  if (!storage || !devices) {
    return (
      <Section title="Folders">
        <Card>
          <ErrorRow title="Could not load folders" detail={error} retry={load} />
        </Card>
      </Section>
    );
  }

  // the computers a folder can go on: this account's own, and for an admin the team's AI worker (the server takes both)
  const own = devices.filter((d) => d.owner === me.username || (me.role === "admin" && d.owner === "workspace"));
  // a hosted member with no computer has nothing to put a folder on: say so once, instead of three Set folder buttons
  if (hosted && own.length === 0 && storage.folders.length === 0) {
    return (
      <Section title="Folders">
        <Card>
          <EmptyRow title="No computer yet" description="Footage, music and finished videos are folders on one of your computers. Add one in Computers." />
        </Card>
      </Section>
    );
  }

  // an admin's folders may be a plug-in's own store (the AI Editor's): its screen then stands in for the rows and its header
  const Replaced = me.role === "admin" ? replacementFor(webPlugins, "storage") : undefined;

  return (
    <>
      {Replaced ? (
        <Replaced />
      ) : (
        <Section title="Folders" action={own.length > 0 ? <AddStorageButton devices={own} serverDisks={storage.serverDisks} here={storage.here} onChanged={load} /> : undefined}>
          <Storage devices={own} storage={storage} onChanged={load} />
        </Section>
      )}

    </>
  );
}
