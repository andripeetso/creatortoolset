import { useEffect, useState } from "react";
import { postToApp } from "@/lib/mac-record";

/** Inside the Mac app (it sets <html data-mac-this-mac>): Settings shows this Mac's switch and the servers. A browser never does. */
export const hasThisMac = () => typeof document !== "undefined" && document.documentElement.dataset.macThisMac === "1";

/**
 * What the app reports (apps/mac ThisMacBridge.swift `thisMacState`). `shortcut` (the recording shortcut's display, "" =
 * none) and `limits` (Plan limits reading on) are missing in older Mac apps: a row that needs one is not shown then.
 */
export type ThisMacState = {
  answer: string;
  aiOn: boolean;
  running: number;
  lastError: string | null;
  notice: string | null;
  paired: boolean;
  problem: string | null;
  servers: Array<{ id: string; name: string; url: string; current: boolean }>;
  shortcut?: string;
  limits?: boolean;
  /** this Mac's names (the Devices page merges its records by them); missing in older Mac apps */
  computer?: string;
  host?: string;
  device?: string | null;
};

/** `thismac-<what>` to the app; it answers every one with a `mac-this` event carrying its state. */
export const tell = (what: string) => postToApp(`thismac-${what}`);

/**
 * The app's state, polled while a Settings page that shows it is open. `on` = false (a browser, or a page that does not
 * need it) reads nothing and sends nothing.
 */
export function useThisMac(on: boolean): ThisMacState | null {
  const [state, setState] = useState<ThisMacState | null>(null);
  useEffect(() => {
    if (!on) return;
    const handle = (e: Event) => setState((e as CustomEvent<ThisMacState>).detail);
    window.addEventListener("mac-this", handle);
    tell("state");
    // ponytail: polls while the page is open; the app could push on change if this ever matters
    const timer = setInterval(() => tell("state"), 3000);
    return () => {
      window.removeEventListener("mac-this", handle);
      clearInterval(timer);
    };
  }, [on]);
  return state;
}
