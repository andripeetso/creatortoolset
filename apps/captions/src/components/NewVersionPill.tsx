import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

/** The file name of the build's entry script in an index.html ("app-<hash>.js"): it changes with every deploy. */
export const entryOf = (html: string): string | null => /<script[^>]*type="module"[^>]*src="[^"]*?([^/"]+)"/.exec(html)?.[1] ?? null;

/**
 * "Update" in the bottom-left corner: a window left open (the Mac app above all) keeps the code it loaded. On focus
 * and every 10 minutes it reads index.html; a different entry script means a deploy happened. Reloading is the
 * person's choice, so nothing typed is lost.
 */
export function UpdateButton() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src.split("/").pop();
    let last = 0;
    const check = () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      fetch("/", { cache: "no-store" })
        .then((r) => (r.ok ? r.text() : ""))
        .then((html) => {
          const live = entryOf(html);
          if (live && live !== mine) setReady(true);
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
  if (!ready) return null;
  return (
    <button
      type="button"
      onClick={() => location.reload()}
      title="A new version of Creator Toolset is ready: reload to use it"
      className="flex h-7 items-center gap-1.5 rounded-md bg-violet-600 px-2.5 text-xs font-medium text-white hover:bg-violet-500"
    >
      <RefreshCw className="h-3.5 w-3.5" />
      Update
    </button>
  );
}
