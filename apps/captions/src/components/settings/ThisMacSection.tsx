import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { putCached, readCached } from "@/lib/local-cache";
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
  /** Settings → General → Dictation (apps/mac Dictation.swift `bridgeState`); missing in older Mac apps */
  dictation?: DictationState;
  /** the Mac app's version (CFBundleShortVersionString); missing in older Mac apps */
  version?: string;
  /** the app's last answer, kept on this device: it has not answered in this window yet */
  saved?: true;
};

/** Dictation on this Mac, as the app keeps it; the page sets it with `thismac-dictation:<what>:<value>`. */
export type DictationState = {
  on: boolean;
  /** the key held to talk, or "off" */
  hold: string;
  holdKeys: Array<{ id: string; name: string }>;
  model: string;
  /** `here`: on this Mac; `removable`: this app downloaded it; `progress`: 0–1 while it downloads */
  models: Array<{ id: string; name: string; size: string; here: boolean; removable: boolean; progress: number | null }>;
  keep: number;
  sounds: boolean;
  /** the permission still to give, or null */
  needs: "Microphone" | "Accessibility" | null;
};

/** Where the app's last answer is kept (lib/local-cache), so a page that shows it paints at once. */
const SAVED = "mac-this";

/** `thismac-<what>` to the app; it answers every one with a `mac-this` event carrying its state. */
export const tell = (what: string) => postToApp(`thismac-${what}`);

/**
 * The app's state, polled while a Settings page that shows it is open: its last answer at once (`saved`), then each new
 * one. `on` = false (a browser, or a page that does not need it) reads nothing and sends nothing.
 */
export function useThisMac(on: boolean): ThisMacState | null {
  const user = useAuth((s) => s.me?.username ?? null);
  const [state, setState] = useState<ThisMacState | null>(() => {
    // read whenever the app is here, so a caller that turns `on` later (the account menu, on open) paints its last answer at once
    const kept = hasThisMac() ? readCached<ThisMacState>(user, SAVED) : null;
    return kept && { ...kept, saved: true };
  });
  useEffect(() => {
    if (!on) return;
    let last = JSON.stringify(readCached<ThisMacState>(user, SAVED));
    const handle = (e: Event) => {
      const next = (e as CustomEvent<ThisMacState>).detail;
      setState(next);
      // the app answers every 3 s: kept only when it says something new
      const text = JSON.stringify(next);
      if (text !== last) putCached(user, SAVED, next);
      last = text;
    };
    window.addEventListener("mac-this", handle);
    tell("state");
    // ponytail: polls while the page is open; the app could push on change if this ever matters
    const timer = setInterval(() => tell("state"), 3000);
    return () => {
      window.removeEventListener("mac-this", handle);
      clearInterval(timer);
    };
  }, [on, user]);
  return state;
}
