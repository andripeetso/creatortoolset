import { useEffect, useState, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { connected, onConnection } from "@/lib/sync";

/**
 * In the bar on top of every page, beside the account: while the live stream can't reach the server (lib/sync.ts), a
 * quiet "Reconnecting" after 2 s (a short drop never flashes it), "Can't reach the server" after 30 s. It goes away by
 * itself once the stream is back. On a phone it is the spinner alone, so the bar keeps its one row.
 */
export function ConnectionPill() {
  const up = useSyncExternalStore(onConnection, connected);
  const [shown, setShown] = useState<null | "Reconnecting" | "Can't reach the server">(null);
  useEffect(() => {
    setShown(null);
    if (up) return;
    const soon = setTimeout(() => setShown("Reconnecting"), 2000);
    const late = setTimeout(() => setShown("Can't reach the server"), 30_000);
    return () => {
      clearTimeout(soon);
      clearTimeout(late);
    };
  }, [up]);
  if (!shown) return null;
  return (
    <span role="status" data-connection-pill className="flex h-8 items-center gap-1.5 px-1 text-xs text-muted-foreground">
      <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
      <span className="sr-only sm:not-sr-only">{shown}</span>
    </span>
  );
}
