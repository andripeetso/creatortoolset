import { ArrowUpCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { hasThisMac, tell, type ThisMacState } from "@/components/settings/ThisMacSection";

/**
 * The oldest Mac app these pages work with. Raise it in the same commit as a page change that needs a newer Mac app
 * (a new bridge message, or a ThisMacState field it can't do without): an older app then shows this strip instead of a
 * feature that does nothing. "0.0.0" = every Mac app works.
 */
export const MIN_MAC_APP = "0.0.0";

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

/** Inside a Mac app older than MIN_MAC_APP: one strip saying to update it. A browser never shows it. */
export function MacAppUpdateBanner() {
  const [old, setOld] = useState(false);
  useEffect(() => {
    if (!hasThisMac() || MIN_MAC_APP === "0.0.0") return;
    const handle = (e: Event) => setOld(olderThan((e as CustomEvent<ThisMacState>).detail?.version, MIN_MAC_APP));
    window.addEventListener("mac-this", handle, { once: true });
    tell("state");
    return () => window.removeEventListener("mac-this", handle);
  }, []);
  if (!old) return null;
  return (
    <div
      role="status"
      className="relative z-[60] flex h-11 shrink-0 items-center gap-3 overflow-hidden border-b border-amber-400/60 bg-amber-500/15 px-3 text-amber-900 dark:text-amber-100"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-600 dark:text-amber-400">
        <ArrowUpCircle className="h-4 w-4" />
      </span>
      <div className="min-w-0 leading-tight">
        <span className="block truncate text-xs font-semibold">Update Creator Toolset to keep everything working</span>
        <span className="hidden text-[10px] opacity-70 sm:block">Creator Toolset menu → Check for Updates…</span>
      </div>
    </div>
  );
}
