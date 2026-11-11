import { useEffect, useState } from "react";
import { Link } from "react-router";
import { planAlert } from "@/lib/limits";
import { useProviders } from "@/lib/providers";

/**
 * In the bar on top of every page, beside the account: an amber line while an AI plan is used up or nearly (lib/limits.ts
 * planAlert), opening Settings → Usage. Nothing while every plan has room. On a phone it is an amber dot on the account
 * button's corner, taking no room in the bar, so the bar keeps its one row (AppBar puts the two in one box).
 */
export function PlanLimitPill() {
  const view = useProviders().data;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000); // "resets in 2h 5m" counts down
    return () => clearInterval(t);
  }, []);
  const alert = view ? planAlert(view, now) : null;
  if (!alert) return null;
  return (
    <Link
      to="/settings/usage"
      title={alert.full}
      className="flex h-8 max-w-72 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300 max-sm:absolute max-sm:-right-1.5 max-sm:-top-1.5 max-sm:z-10 max-sm:size-5 max-sm:justify-center max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:hover:bg-transparent"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500 max-sm:size-2.5 max-sm:ring-2 max-sm:ring-background" />
      {/* a phone shows the dot alone; the words stay for a screen reader */}
      <span className="sr-only truncate sm:not-sr-only">{alert.text}</span>
    </Link>
  );
}
