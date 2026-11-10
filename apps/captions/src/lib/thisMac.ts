// This Mac's AI, as the Mac app reports it to the page. Only the Mac app has the bridge ("thisMac" handler, TitleBar.swift);
// in a browser there is none and the functions answer null.

/** `device`: this Mac's device id on the open server, once paired (null before that). */
export type ThisMacState = { aiOn: boolean; paired: boolean; device?: string | null };
type Bridge = { postMessage: (m: string) => Promise<ThisMacState> };

/** The Mac app's bridge, or undefined in a browser. */
export function thisMacBridge(): Bridge | undefined {
  return (window as unknown as { webkit?: { messageHandlers?: { thisMac?: Bridge } } }).webkit?.messageHandlers?.thisMac;
}

/**
 * Turns this Mac's AI on and pairs it with this server (the Mac app does both, then answers). Resolves once the
 * device exists, so the next AI check can find it. null in a browser or when the Mac app does not answer.
 * Setup calls it before connecting an AI on a Mac app's first run (AiPanel.tsx).
 */
export async function startThisMac(): Promise<ThisMacState | null> {
  const bridge = thisMacBridge();
  if (!bridge) return null;
  try {
    return await bridge.postMessage("start");
  } catch {
    return null;
  }
}
