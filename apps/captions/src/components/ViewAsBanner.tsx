import { useEffect } from "react";
import { Eye, RotateCcw } from "lucide-react";
import { isDemo, logout, useAuth, viewAsOption } from "@/lib/auth";

/** Always-visible admin escape hatch while a role preview is active. */
export function ViewAsBanner() {
  const viewAs = useAuth((state) => state.viewAs);
  const setViewAs = useAuth((state) => state.setViewAs);
  const option = viewAsOption(viewAs);

  if (!option) return null;

  return (
    <div
      role="status"
      className="relative z-[60] flex h-11 shrink-0 items-center gap-3 overflow-hidden border-b border-fuchsia-300/25 bg-gradient-to-r from-fuchsia-700 via-violet-700 to-indigo-700 px-3 text-white shadow-lg shadow-fuchsia-950/25"
    >
      <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_15%_50%,white_0,transparent_24%),radial-gradient(circle_at_80%_10%,white_0,transparent_20%)]" />
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20">
        <Eye className="h-4 w-4" />
      </span>
      <div className="relative min-w-0 leading-tight">
        <span className="block truncate text-xs font-semibold">
          Viewing as {option.label}
        </span>
        <span className="hidden text-[10px] text-white/70 sm:block">
          UI preview · still signed in as admin · {option.description}
        </span>
      </div>
      <button
        onClick={() => setViewAs(null)}
        className="relative ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-white/30 bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/20"
      >
        <RotateCcw className="h-3 w-3" /> Exit view
      </button>
    </div>
  );
}

/**
 * The demo (api/auth.ts): a thick frame round the viewport, "Demo mode" and
 * "Exit demo" (back to the login screen) top left, nothing else. Nothing a
 * visitor changes is saved: outside their own copy of
 * Review a change never leaves the page, it ends like a cancelled request so
 * pages say nothing, and the server would refuse it anyway (boot.ts).
 */
const DEMO_KEPT = /^\/api\/auth\/|^\/api\/review\//;
const DEMO_DROPPED = /^\/api\/review\/(?:uploads|relay)(?:\/|$)|^\/api\/review\/assets\/[^/]+\/v\/\d+\/(?:captions|content|refs)$/;

export function DemoBanner() {
  const demo = useAuth((state) => isDemo(state.me));

  useEffect(() => {
    if (!demo) return;
    const plain = window.fetch;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const url = new URL(request?.url ?? String(input), window.location.href);
      const saves = method !== "GET" && method !== "HEAD" && url.origin === window.location.origin;
      if (saves && (!DEMO_KEPT.test(url.pathname) || DEMO_DROPPED.test(url.pathname))) {
        return Promise.reject(new DOMException("", "AbortError"));
      }
      return plain(input, init);
    };
    return () => {
      window.fetch = plain;
    };
  }, [demo]);

  if (!demo) return null;

  return (
    <>
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[70] rounded-b-[10px] border-[6px] border-emerald-500" />
      <div className="fixed left-0 top-0 z-[71] flex items-center gap-px text-[11px] font-semibold text-black">
        <span className="rounded-br-md bg-emerald-500 px-2 py-0.5">Demo mode</span>
        <button
          type="button"
          onClick={() => void logout()}
          className="rounded-b-md bg-white/90 px-2 py-0.5 hover:bg-white"
        >
          Exit demo
        </button>
      </div>
    </>
  );
}
