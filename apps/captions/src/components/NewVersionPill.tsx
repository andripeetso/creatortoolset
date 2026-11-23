import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The file name of the build's entry script in an index.html ("app-<hash>.js"): it changes with every deploy. */
export const entryOf = (html: string): string | null => /<script[^>]*type="module"[^>]*src="[^"]*?([^/"]+)"/.exec(html)?.[1] ?? null;

/** A new Mac app the Mac app has downloaded and holds until a restart (apps/mac Updates.swift sets <html data-mac-update>). */
export type MacUpdate = { version: string; critical: boolean; since: number; waiting: boolean };

export const readMacUpdate = (): MacUpdate | null => {
  try {
    const u = JSON.parse(document.documentElement.dataset.macUpdate ?? "null") as MacUpdate | null;
    return u && typeof u.version === "string" ? u : null;
  } catch {
    return null;
  }
};

/** The held Mac update, kept current as the app reports it ('mac-update'). */
export function useMacUpdate(): MacUpdate | null {
  const [mac, setMac] = useState(readMacUpdate);
  useEffect(() => {
    const read = () => setMac(readMacUpdate());
    window.addEventListener("mac-update", read);
    return () => window.removeEventListener("mac-update", read);
  }, []);
  return mac;
}

const DAY = 24 * 60 * 60_000;
/** How loudly a held Mac update is offered: the corner button, or a card once its release is critical or it waited a day. */
export const macUpdateLevel = (u: MacUpdate | null, now: number): "none" | "button" | "card" =>
  !u ? "none" : u.critical || now - u.since >= DAY ? "card" : "button";

const tellMac = (m: string) =>
  (window as unknown as { webkit?: { messageHandlers?: { window?: { postMessage: (m: string) => void } } } }).webkit?.messageHandlers?.window?.postMessage(m);

/** Asks the Mac app to install the update it holds and relaunch (UpdateWhenIdle.installNow). */
export const restartMac = () => tellMac("update-install");

/**
 * "Update" in the bottom-left corner. In the Mac app, when it has downloaded a new version: Restart to update (the
 * relaunch also brings the newest page), and after a day, or at once for a release marked critical, a card in the same
 * corner, over the page so nothing moves. Otherwise after a deploy: a window left open keeps the code it loaded, so on
 * focus and every 10 minutes it reads index.html; a different entry script means a deploy happened. Reloading or
 * restarting is the person's choice, so nothing typed is lost.
 */
export function UpdateButton() {
  const [ready, setReady] = useState(false);
  const mac = useMacUpdate();
  const [now, setNow] = useState(Date.now);
  const [later, setLater] = useState(false);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10 * 60_000);
    return () => clearInterval(timer);
  }, [mac]);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src.split("/").pop();
    let last = 0;
    let told = false;
    const check = () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      fetch("/", { cache: "no-store" })
        .then((r) => (r.ok ? r.text() : ""))
        .then((html) => {
          const live = entryOf(html);
          if (!live || live === mine) return;
          // a release often follows the server's new pages: the Mac app looks now, so one restart brings both
          if (!told) tellMac("update-check");
          told = true;
          setReady(true);
        })
        .catch(() => {});
    };
    const timer = setInterval(check, 10 * 60_000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (mac && macUpdateLevel(mac, now) === "card" && !(later && !mac.critical)) {
    return (
      <div role="status" className="w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
        <p className="text-sm font-medium">Creator Toolset {mac.version} is ready</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {mac.critical ? "An important fix. " : ""}Restarting takes a few seconds and opens this page again.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          {!mac.critical && (
            <Button size="sm" variant="ghost" onClick={() => setLater(true)}>
              Later
            </Button>
          )}
          <Button size="sm" disabled={mac.waiting} onClick={restartMac}>
            {mac.waiting ? "Updates when done" : "Restart now"}
          </Button>
        </div>
      </div>
    );
  }
  if (!mac && !ready) return null;
  return (
    <button
      type="button"
      disabled={mac?.waiting}
      onClick={mac ? restartMac : () => location.reload()}
      title={mac ? `Creator Toolset ${mac.version} is downloaded: restart to use it` : "A new version of Creator Toolset is ready: reload to use it"}
      className="flex h-7 items-center gap-1.5 rounded-md bg-violet-600 px-2.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-60"
    >
      <RefreshCw className="h-3.5 w-3.5" />
      {mac ? (mac.waiting ? "Updates when done" : "Restart to update") : "Update"}
    </button>
  );
}
