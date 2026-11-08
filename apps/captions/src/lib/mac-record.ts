import { useEffect, useState } from "react";

/** The Mac app's screen recorder (apps/mac Recorder.swift): offered only where the app can record (macOS 15+;
 *  it sets <html data-mac-record>). Record buttons open its toolbar; recordings are local projects on this Mac
 *  (see LocalRecording) until they are sent somewhere. */
export const canRecordScreen = () => typeof document !== "undefined" && document.documentElement.dataset.macRecord === "1";

/** Where a local recording is sent from the page or the /record list. */
export type ShareDest = "review" | "notes" | "guide";

/** A message to the app: the text after `record-` (the app strips the prefix). */
export type RecorderMessage =
  | "toolbar"
  | "stop"
  | "folder"
  | "show"
  | "state"
  | "list"
  | `share:${string}:${ShareDest}`
  | `reveal:${string}`
  | `delete:${string}`;

/** Posts a raw message to the app (no-op outside it). */
export function postToApp(message: string) {
  (window as unknown as { webkit?: { messageHandlers?: { window?: { postMessage: (m: string) => void } } } }).webkit
    ?.messageHandlers?.window?.postMessage(message);
}

/** `record-<message>` to the app. */
export function tellRecorder(message: RecorderMessage) {
  postToApp(`record-${message}`);
}

/** Opens the app's recording toolbar (nothing starts until the user picks a source and Start). */
export const openRecorder = () => tellRecorder("toolbar");

export type RecorderPhase = "idle" | "toolbar" | "countdown" | "recording" | "paused" | "saving" | "uploading";

/** The recorder's phase and recordings folder, as the app reports them. `busy`: a take is running (not idle or at the toolbar). */
export function useRecorderState(): { phase: RecorderPhase; busy: boolean; folder: string; shortcut: string } {
  const [state, setState] = useState<{ phase: RecorderPhase; folder: string; shortcut?: string }>({ phase: "idle", folder: "" });
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent<{ phase: RecorderPhase; folder: string; shortcut?: string }>).detail);
    const ask = () => tellRecorder("state");
    window.addEventListener("mac-recorder", on);
    window.addEventListener("focus", ask); // the folder may have changed in the app's menu
    ask();
    return () => {
      window.removeEventListener("mac-recorder", on);
      window.removeEventListener("focus", ask);
    };
  }, []);
  return { ...state, shortcut: state.shortcut ?? "", busy: state.phase !== "idle" && state.phase !== "toolbar" };
}

/** A recording still on this Mac: a local project folder in the recordings folder. */
export type LocalRecording = {
  id: string;
  name: string;
  /** ms since 1970 */
  createdAt: number;
  durationMs: number;
  width: number;
  height: number;
  camera: boolean;
};

/** The local recordings, newest first (null until the app answers). Refreshed after every stop and delete. */
export function useLocalRecordings(): LocalRecording[] | null {
  const [items, setItems] = useState<LocalRecording[] | null>(null);
  useEffect(() => {
    const on = (e: Event) => setItems((e as CustomEvent<{ items: LocalRecording[] }>).detail.items);
    window.addEventListener("mac-recordings", on);
    tellRecorder("list");
    return () => window.removeEventListener("mac-recordings", on);
  }, []);
  return items;
}
