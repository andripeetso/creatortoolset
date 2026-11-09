import { useEffect, useState } from "react";
import { getProviders } from "@/lib/providers";
import { useMe } from "@/lib/auth";
import { Storage, getStorage } from "@/components/settings/DevicesSection";
import type { StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";

/** Step 3 container: this account's computers and their folders, through the Devices storage the Settings page uses. */
export function FoldersStep() {
  const me = useMe();
  const [view, setView] = useState<ProvidersView | null>(null);
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = () => {
    getProviders()
      .then((v) => {
        setView(v);
        setFailed(false);
      })
      .catch(() => setFailed(true));
    getStorage().then(setStorage).catch(() => setStorage(null));
  };
  useEffect(reload, []);
  if (failed) return <p className="text-sm text-muted-foreground">Couldn't load your computers. Check the connection, then reopen this step.</p>;
  if (!view || !me) return <p className="text-sm text-muted-foreground">Looking for your computers…</p>;
  // storage is this account's own: only its own computers can hold its folders
  const own = view.devices.filter((d) => d.owner === me.username);
  return <Storage devices={own} storage={storage} onChanged={reload} />;
}
