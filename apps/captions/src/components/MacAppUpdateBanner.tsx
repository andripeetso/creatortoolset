import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { restartMac, useMacUpdate } from "@/components/NewVersionPill";
import { hasThisMac, tell, type ThisMacState } from "@/components/settings/ThisMacSection";

/**
 * The oldest Mac app these pages work with. Raise it in the same commit as a page change that needs a newer Mac app
 * (a new bridge message, or a ThisMacState field it can't do without): an older app is then blocked by this dialog
 * until it restarts into the update, instead of showing a feature that does nothing. "0.0.0" = every Mac app works.
 */
// 0.22.0: Face Blur at intake runs as the device job "faceblur-intake", which older Mac apps never claim
// 0.29.0: its worker says when the Download location's disk is not connected and then makes no proxy; an older one keeps
// writing proxies to the internal disk in its place. It also answers where a clip's kept proxy is (Show proxy in Finder)
export const MIN_MAC_APP: string = "0.29.0";

/** a < b for dotted versions ("0.9.1" < "0.15.0"). A Mac app from before it reported its version counts as "0"; "dev" builds are never old. */
export function olderThan(a: string | undefined, b: string): boolean {
  if (a === "dev") return false;
  const x = (a ?? "0").split(".").map((n) => parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/**
 * Inside a Mac app older than MIN_MAC_APP, once it has downloaded the update (it does so by itself, Updates.swift): a
 * dialog over the whole app until Restart to update. Before that nothing shows, so a server that takes the new pages
 * before their release exists never locks anyone out. A browser never shows it.
 */
export function MacAppUpdateBanner() {
  const [old, setOld] = useState(false);
  const held = useMacUpdate();
  useEffect(() => {
    if (!hasThisMac() || MIN_MAC_APP === "0.0.0") return;
    const handle = (e: Event) => setOld(olderThan((e as CustomEvent<ThisMacState>).detail?.version, MIN_MAC_APP));
    window.addEventListener("mac-this", handle, { once: true });
    tell("state");
    return () => window.removeEventListener("mac-this", handle);
  }, []);
  if (!old || !held) return null;
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-sm"
      >
        <DialogHeader>
          <DialogTitle>Update Creator Toolset</DialogTitle>
          <DialogDescription className="text-pretty">This server needs Creator Toolset {MIN_MAC_APP} or newer.</DialogDescription>
        </DialogHeader>
        <Button disabled={held.waiting} onClick={restartMac}>
          {held.waiting ? "Updates when done" : "Restart to update"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
