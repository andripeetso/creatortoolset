import { Eye, RotateCcw } from "lucide-react";
import { useAuth } from "@/lib/auth";

/**
 * Hosted: a platform admin is reading the app as another account (view-as, read-only). The server answers as that
 * account; this strip says whose eyes these are and ends the view (DELETE /api/admin/view-as).
 */
export function ViewAsBanner() {
  const viewedBy = useAuth((s) => s.viewedBy);
  const me = useAuth((s) => s.me);
  if (!viewedBy || !me) return null;

  const exit = async () => {
    await fetch("/api/admin/view-as", { method: "DELETE" }).catch(() => {});
    window.location.reload();
  };

  return (
    <div
      role="status"
      className="relative z-[60] flex h-11 shrink-0 items-center gap-3 overflow-hidden border-b border-amber-400/60 bg-amber-500/15 px-3 text-amber-900 dark:text-amber-100"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-600 dark:text-amber-400">
        <Eye className="h-4 w-4" />
      </span>
      <div className="min-w-0 leading-tight">
        <span className="block truncate text-xs font-semibold">Viewing as {me.name || me.username}</span>
        <span className="hidden text-[10px] opacity-70 sm:block">Read-only · still signed in as {viewedBy}</span>
      </div>
      <button
        onClick={() => void exit()}
        className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/40 px-2.5 py-1 text-[11px] font-medium hover:bg-amber-500/15"
      >
        <RotateCcw className="h-3 w-3" /> Exit view
      </button>
    </div>
  );
}
