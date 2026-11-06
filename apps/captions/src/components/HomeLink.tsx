import { useId } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { toolsetHomePath } from "@/lib/mobile";

/** The Creator Toolset logo, "CT, one stroke": the same mark as the favicon in index.html and
 *  the app icons (the app icon), white to lavender on deep violet. */
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

/** Always-on way back to the Creator Toolset dashboard; a real link, so it opens in a new tab too. */
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
      onClick={onClick}
      title="Creator Toolset"
      aria-label="Creator Toolset home"
      className={cn("shrink-0 rounded-md p-1 hover:bg-zinc-500/15", className)}
    >
      <ToolsetLogo className="h-6 w-6" />
    </Link>
  );
}
