import { useEffect, useState } from "react";
import { useMacUpdate } from "@/components/NewVersionPill";
import { hasThisMac, tell, type ThisMacState } from "@/components/settings/ThisMacSection";

/**
 * The oldest Mac app these pages work with. Raise it in the same commit as a page change that needs a newer Mac app
 * (a new bridge message, or a ThisMacState field it can't do without): an older app then shows this strip instead of a
 * feature that does nothing. "0.0.0" = every Mac app works.
 */
// 0.22.0: Face Blur at intake runs as the device job "faceblur-intake", which older Mac apps never claim
export const MIN_MAC_APP: string = "0.22.0";

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
 * Inside a Mac app older than MIN_MAC_APP, with no update downloaded yet: a card in the bottom-left corner (CornerNav)
 * saying to update it, over the page so nothing moves. A downloaded update is UpdateButton's. A browser never shows it.
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
  if (!old || held) return null;
  return (
    <div role="status" className="w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <p className="text-sm font-medium">Update Creator Toolset</p>
      <p className="mt-1 text-xs text-muted-foreground">Creator Toolset menu → Check for Updates…</p>
    </div>
  );
}
