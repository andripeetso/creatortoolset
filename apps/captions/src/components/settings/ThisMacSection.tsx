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
  /** Settings → Tools → Screen Recorder (apps/mac RecordTypes.swift `RecordPrefs`): streams saved separately, the screen's longest side, the camera's height; missing in older Mac apps */
  recorder?: { keep: boolean; screen: number; camera: number; faces?: boolean };
  /** the Mac app's version (CFBundleShortVersionString); missing in older Mac apps */
  version?: string;
  /** the app's last answer, kept on this device: it has not answered in this window yet */
  saved?: true;
};

export type DictationAction = "talk" | "history" | "file" | "cancel";

/** Dictation on this Mac, as the app keeps it; the page sets it with `thismac-dictation:<what>:<value>`. */
export type DictationState = {
  on: boolean;
  /** each action's key as shown ("F13", "⌥Space", "Hold fn"; "" = none) */
  keys: Record<DictationAction, string>;
  /** the action whose key the app is waiting for */
  picking: DictationAction | null;
  /** why no key works right now (another dictation app has them), one quiet line; missing in older Mac apps */
  paused?: string | null;
  /** the setup page was gone through and it has what it needs (permissions, a model or server); missing in older Mac apps */
  setUp?: boolean;
  /** who writes the words down: this Mac's model, or the server's engine (POST /api/transcribe/mic); missing in older Mac apps */
  engine?: "mac" | "server";
  model: string;
  /** `here`: on this Mac; `removable`: this app downloaded it; `progress`: 0–1 while it downloads */
  models: Array<{ id: string; name: string; size: string; here: boolean; removable: boolean; progress: number | null }>;
  keep: number;
  sounds: boolean;
  /** the person's own speech server, tried before this Mac's model ("" = none); missing in older Mac apps */
  server?: string;
  /** the permission still to give, or null */
  needs: "Microphone" | "Accessibility" | null;
};

/** Where the app's last answer is kept (lib/local-cache), so a page that shows it paints at once. */
const SAVED = "mac-this";

/** `thismac-<what>` to the app; it answers every one with a `mac-this` event carrying its state. */
export const tell = (what: string) => postToApp(`thismac-${what}`);

/**
 * Whether this Mac app has the Screen Recorder's settings and Save the streams… (it reports `recorder`; 0.15.38 and
 * later): true, false, or null while an app that has not answered in this window may still say so. False outside the
 * app. Asks the app once, without polling; its last answer on this device counts at once.
 */
export function useMacRecorder(): boolean | null {
  const r = useMacRecorderState();
  return r === null ? null : !!r;
}

/** What the Mac app says of its Screen Recorder (`recorder`: its settings and what it can do), false where it says nothing, null until it answers. */
export function useMacRecorderState(): NonNullable<ThisMacState["recorder"]> | false | null {
  const user = useAuth((s) => s.me?.username ?? null);
  const [has, setHas] = useState<NonNullable<ThisMacState["recorder"]> | false | null>(() => {
    if (!hasThisMac()) return false;
    return readCached<ThisMacState>(user, SAVED)?.recorder ?? null;
  });
  useEffect(() => {
    if (!hasThisMac()) return;
    const handle = (e: Event) => setHas((e as CustomEvent<ThisMacState>).detail?.recorder ?? false);
    window.addEventListener("mac-this", handle);
    tell("state");
    return () => window.removeEventListener("mac-this", handle);
  }, []);
  return has;
}

/**
 * What a message box's mic does in this window: `record` as on the web (a browser, a Mac app without dictation or too
 * old to say whether it is set up, or one that has not answered yet), `none` when the Mac's dictation is set up and on,
 * so the talk key does it, `setup` when a click opens dictation's setup page. After that click, `watch()` asks the
 * app again every 3 s until it is set up.
 */
export function useMicMode(): { mic: "record" | "none" | "setup"; watch: () => void } {
  const user = useAuth((s) => s.me?.username ?? null);
  const [d, setD] = useState<DictationState | undefined>(() => (hasThisMac() ? readCached<ThisMacState>(user, SAVED)?.dictation : undefined));
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!hasThisMac()) return;
    const handle = (e: Event) => setD((e as CustomEvent<ThisMacState>).detail?.dictation);
    window.addEventListener("mac-this", handle);
    tell("state");
    return () => window.removeEventListener("mac-this", handle);
  }, []);
  // an older Mac app (no setUp) still has the four-step guide: its mic records as before
  const mic = !d || d.setUp === undefined ? "record" : d.on && d.setUp ? "none" : "setup";
  useEffect(() => {
    if (!watching || mic !== "setup") return;
    const timer = setInterval(() => tell("state"), 3000);
    return () => clearInterval(timer);
  }, [watching, mic]);
  return { mic, watch: () => setWatching(true) };
}

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
