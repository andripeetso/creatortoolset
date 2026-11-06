/**
 * Multi-tab guard. The app autosaves whole editor states, so two tabs on
 * the same project silently overwrite each other (a stale tab's autosave
 * resurrects old transcripts over fresh work — indistinguishable from
 * "apply didn't land"). BroadcastChannel lets every open tab know it's
 * not alone; the store raises tabConflict and the UI shows a banner.
 */
export function initTabGuard(onConflict: () => void): void {
  if (typeof BroadcastChannel === "undefined") return;
  const id = `${Date.now()}-${Math.random()}`;
  const ch = new BroadcastChannel("caption-studio-tabs");
  ch.onmessage = (e) => {
    const data = e.data as { type?: string; id?: string } | null;
    if (!data?.type || data.id === id) return;
    if (data.type === "open") {
      // a new tab just appeared — warn here and tell it we're here too
      ch.postMessage({ type: "already-open", id });
      onConflict();
    } else if (data.type === "already-open") {
      onConflict();
    }
  };
  ch.postMessage({ type: "open", id });
}
