/** The Mac app's own screen recorder (apps/mac Recorder.swift): offered only where the app can record (macOS 15+;
 *  it sets <html data-mac-record>). The finished recording uploads by itself and that page opens. */
export const canRecordScreen = () => typeof document !== "undefined" && document.documentElement.dataset.macRecord === "1";

export function recordScreen(to: "review" | "notes") {
  (window as unknown as { webkit?: { messageHandlers?: { window?: { postMessage: (m: string) => void } } } }).webkit
    ?.messageHandlers?.window?.postMessage(`record-${to}`);
}
