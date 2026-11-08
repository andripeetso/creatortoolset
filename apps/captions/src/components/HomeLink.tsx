import { useId } from "react";
import { Link, useLocation, useNavigate, useNavigationType } from "react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { toolsetHomePath } from "@/lib/mobile";
import { historyDepth, pageStep } from "@/lib/history-depth";

/** Back and forward in the Mac app's top bar. Shown only there, after the name, so the name never
 *  moves; a browser has its own buttons. They step between pages only, never onto Settings, Community or Projects.
 *  Disabled where there is nowhere to go. */
export function HistoryArrows({ className }: { className?: string }) {
  const navigate = useNavigate();
  const navType = useNavigationType();
  const { key } = useLocation();
  const idx = (window.history.state?.idx as number | undefined) ?? 0;
  historyDepth.deepest = navType === "PUSH" ? idx : Math.max(historyDepth.deepest, idx);
  void key; // re-render on every location change
  if (!document.documentElement.classList.contains("mac-app")) return null;
  const back = pageStep(idx, -1);
  const forward = pageStep(idx, 1);
  const button = "rounded-md p-1.5 text-zinc-500 hover:bg-zinc-500/15 hover:text-inherit disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <button type="button" aria-label="Back" title="Back" disabled={!back} onClick={() => navigate(back)} className={button}>
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!forward} onClick={() => navigate(forward)} className={button}>
        <ArrowRight className="h-4 w-4" />
      </button>
    </span>
  );
}

/** The Creator Toolset logo, "CT, one stroke": the same mark as the favicon in index.html and
 *  the app icons, white to lavender on deep violet. */
export function ToolsetLogo({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={`${id}g`} cy=".46">
          <stop offset="0" stopColor="#4A28D0" />
          <stop offset="1" stopColor="#0C0818" />
        </radialGradient>
        <linearGradient id={`${id}w`} gradientUnits="userSpaceOnUse" x1="0" y1="200" x2="0" y2="840">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E4DCFF" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="230" fill={`url(#${id}g)`} />
      <g fill={`url(#${id}w)`} transform="translate(-28 0)">
        <path d="M440 285A235 235 0 1 0 610 682" fill="none" stroke={`url(#${id}w)`} strokeWidth="130" />
        <rect x="438" y="220" width="500" height="130" />
        <rect x="690" y="220" width="128" height="600" />
      </g>
    </svg>
  );
}

/** Always-on way back to the Creator Toolset dashboard (the wordmark); a real link, so it opens in a new tab too. */
export function HomeLink({
  className,
  onClick,
}: {
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <Link
      to={toolsetHomePath()}
      onClick={(e) => {
        onClick?.(e);
        // already home: the click reloads, so the name always does something
        if (!e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0
          && window.location.pathname === toolsetHomePath()) {
          e.preventDefault();
          window.location.reload();
        }
      }}
      title="Creator Toolset"
      aria-label="Creator Toolset home"
      className={cn("shrink-0 rounded-md px-1.5 py-1 hover:bg-zinc-500/15", className)}
    >
      <Wordmark />
    </Link>
  );
}

/** The name typed out, in the app's top bar instead of the icon (the violet mark fought the project colours).
 *  The second word quieter. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("whitespace-nowrap text-sm font-semibold tracking-tight text-zinc-50", className)}>
      Creator<span className="font-medium text-zinc-500"> Toolset</span>
    </span>
  );
}
