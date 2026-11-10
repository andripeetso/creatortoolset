import { useCallback, useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { getProviders } from "@/lib/providers";
import type { StorageView } from "@contracts/storage";
import { devicesSectionsFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { Advanced, Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Section } from "./ui";
import { msg } from "./helpers";
import { AddStorageButton, Storage, driveList, getStorage, spaceOf, isFull, type Computer } from "./StorageRows";

/**
 * Settings → Storage: where finished videos, footage and music live (one row each), "Add storage", and for an admin the
 * drives under Advanced. A plug-in's Devices sections come after.
 */
export function FoldersSection() {
  const me = useAuth((s) => s.me);
  const hosted = useAuth((s) => s.hosted);
  const [devices, setDevices] = useState<Computer[] | null>(null);
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([getProviders(), getStorage()])
      .then(([v, st]) => {
        setDevices(v.devices);
        setStorage(st);
      })
      .catch((e) => setError(msg(e)));
  }, []);
  useEffect(() => load(), [load]);

  if (!me || (!storage && !error)) {
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

  const own = devices.filter((d) => d.owner === me.username);
  const drives = driveList(own, storage.serverDisks);
  const almost = drives.filter((l) => isFull(l.disk)).length;

  // a hosted member with no computer has nothing to put a folder on: say so once, instead of three Set folder buttons
  if (hosted && own.length === 0 && storage.folders.length === 0) {
    return (
      <Section title="Storage">
        <Card>
          <EmptyRow title="No computer yet" description="Footage, music and finished videos are folders on one of your computers. Add one in Computers." />
        </Card>
      </Section>
    );
  }

  return (
    <>
      <Section title="Storage" action={own.length > 0 ? <AddStorageButton devices={own} onChanged={load} /> : undefined}>
        <Storage devices={own} storage={storage} onChanged={load} />
      </Section>

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
