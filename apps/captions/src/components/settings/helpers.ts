import { DRIVER_MODELS } from "@contracts/providers";

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const selectCls =
  "rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-violet-500 focus:outline-none disabled:opacity-50";

/** The Claude models the API key can run (the same list the Mac's proxy serves). */
export const API_MODELS = DRIVER_MODELS.claude ?? [];

/** "3 min ago", "2 h ago", "4 days ago". */
export function fmtAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const min = Math.round((now - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
