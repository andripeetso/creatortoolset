import { useEffect, useState } from "react";

/** The Mac app's own screen recorder (apps/mac Recorder.swift): offered only where the app can record (macOS 15+;
 *  it sets <html data-mac-record>). The Screen Recorder page (pages/ScreenRecorderPage.tsx) is its home; Review and
 *  Video Notes call it too. A finished recording uploads by itself and that page opens. */
export const canRecordScreen = () => typeof document !== "undefined" && document.documentElement.dataset.macRecord === "1";

export type RecordTarget = "review" | "notes" | "mac";

/** `record-<what>` to the app: start (a target), stop, mic-on/off, sound-on/off, folder, show, state. */
export function tellRecorder(what: RecordTarget | "stop" | "mic-on" | "mic-off" | "sound-on" | "sound-off" | "folder" | "show" | "state") {
  (window as unknown as { webkit?: { messageHandlers?: { window?: { postMessage: (m: string) => void } } } }).webkit
    ?.messageHandlers?.window?.postMessage(`record-${what}`);
}

export const recordScreen = (to: RecordTarget) => tellRecorder(to);

export type RecorderState = {
  phase: "idle" | "countdown" | "recording" | "paused" | "saving" | "uploading";
  mic: boolean;
  sound: boolean;
  folder: string;
};

/** The recorder's state as the app reports it (after every message, and whenever it starts or stops). */
export function useRecorderState(): RecorderState | null {
  const [state, setState] = useState<RecorderState | null>(null);
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent<RecorderState>).detail);
    const ask = () => tellRecorder("state");
    window.addEventListener("mac-recorder", on);
    window.addEventListener("focus", ask); // the choices may have changed in the app's menu
    ask();
    return () => {
      window.removeEventListener("mac-recorder", on);
      window.removeEventListener("focus", ask);
    };
  }, []);
  return state;
}
