import { useCallback } from "react";
import { HardDrive } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { useProviders } from "@/lib/providers";
import type { StorageView } from "@contracts/storage";
import { devicesSectionsFor, replacementFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { Advanced, Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Section } from "./ui";
import { AddStorageButton, Storage, driveList, getStorage, spaceOf, isFull } from "./StorageRows";

/**
 * Settings → Storage: where finished videos, footage and music live (one row each), "Add storage", and for an admin the
 * drives under Advanced. A plug-in's Devices sections come after.
 */
export function FoldersSection() {
  const me = useAuth((s) => s.me);
  const hosted = useAuth((s) => s.hosted);
  const providers = useProviders();
  const store = useCachedLoad<StorageView>("/api/devices/storage", getStorage);
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
      <Section title="Storage">
        <Card>
          <LoadingRow />
        </Card>
      </Section>
    );
  }
  if (!storage || !devices) {
    return (
      <Section title="Storage">
        <Card>
          <ErrorRow title="Could not load storage" detail={error} retry={load} />
        </Card>
      </Section>
    );
  }

  // the computers a folder can go on: this account's own, and for an admin the team's AI worker (the server takes both)
  const own = devices.filter((d) => d.owner === me.username || (me.role === "admin" && d.owner === "workspace"));
  const drives = driveList(own, storage.serverDisks);
  const almost = drives.filter((l) => isFull(l.disk)).length;

  // a hosted member with no computer has nothing to put a folder on: say so once, instead of three Set folder buttons
  if (hosted && own.length === 0 && storage.folders.length === 0) {
    return (
      <Section title="Storage">
        <Card>
          <EmptyRow title="No computer yet" description="Footage, music and finished videos are folders on one of your computers. Add one in Devices." />
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
        <Section title="Storage" action={own.length > 0 ? <AddStorageButton devices={own} serverDisks={storage.serverDisks} onChanged={load} /> : undefined}>
          <Storage devices={own} storage={storage} onChanged={load} />
        </Section>
      )}

      {me.role === "admin" && drives.length > 0 && (
        <Card>
          <Advanced summary={<>Drives{almost > 0 && <span className="text-amber-600 dark:text-amber-400"> · {almost} almost full</span>}</>}>
            {drives.map(({ key, disk, on }) => (
              <ListRow
                key={key}
                icon={<HardDrive className="size-4" />}
                title={disk.name}
                subtitle={`${disk.network ? "Network" : disk.path === "/" ? "Built in" : "Drive"} · ${on} · ${spaceOf(disk)}`}
              />
            ))}
          </Advanced>
        </Card>
      )}

      {devicesSectionsFor(me, webPlugins).map((s) => (
        <Section key={s.id} title={s.title}>
          {s.body}
        </Section>
      ))}
    </>
  );
}
