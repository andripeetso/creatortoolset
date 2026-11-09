import { useEffect, useState, type ReactNode } from "react";
import { getProviders } from "@/lib/providers";
import { useMe } from "@/lib/auth";
import { Storage, getStorage } from "@/components/settings/DevicesSection";
import type { StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";

/** Step 3's frame: the line above the folders, then the folders (the same storage Settings → Devices shows). */
export function FoldersStepView({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Say where your footage, music and finished videos are on each computer. Creator Toolset finds them by a small marker file, and moves nothing.
      </p>
      {children}
    </div>
  );
}

/** Step 3 container: this account's computers and their folders, through the Devices storage the Settings page uses. */
export function FoldersStep() {
  const me = useMe();
  const [view, setView] = useState<ProvidersView | null>(null);
  const [storage, setStorage] = useState<StorageView | null>(null);
  const reload = () => {
    getProviders().then(setView).catch(() => setView(null));
    getStorage().then(setStorage).catch(() => setStorage(null));
  };
  useEffect(reload, []);
  if (!view || !me) return <p className="text-sm text-muted-foreground">Looking for your computers…</p>;
  // storage is this account's own: only its own computers can hold its folders
  const own = view.devices.filter((d) => d.owner === me.username);
  return (
    <FoldersStepView>
      {own.length === 0 && <p className="text-sm text-muted-foreground">No other computer is on your account yet. Folders on this computer can be added now.</p>}
      <Storage devices={own} storage={storage} onChanged={reload} />
    </FoldersStepView>
  );
}
