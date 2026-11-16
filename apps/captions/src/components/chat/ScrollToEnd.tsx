import { ChevronDown } from "lucide-react";

/** The pill at the bottom of a chat list once the reader has scrolled up: one click back to the newest message.
 *  Put it as the list's last child; it takes no room in the list (useFollowEnd decides when it shows). */
export function ScrollToEnd({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none sticky bottom-2 z-10 flex h-0 justify-center">
      <button
        type="button"
        onClick={onClick}
        className="pointer-events-auto -translate-y-full flex items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground shadow-sm hover:bg-muted motion-safe:animate-in motion-safe:fade-in"
      >
        <ChevronDown className="h-3.5 w-3.5" /> Scroll to end
      </button>
    </div>
  );
}
