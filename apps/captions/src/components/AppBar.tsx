import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { HistoryArrows, HomeLink } from "@/components/HomeLink";
import { UserMenu } from "@/components/UserMenu";
import { cn } from "@/lib/utils";

/**
 * The bar on top of every tool: the logo home, the tool (a link back to its start when
 * `to` is set), where you are in it, the page's actions, then the account menu.
 * Colours come from the page: some tools are always
 * dark, others follow the theme, so text inherits and greys are translucent.
 */
export function AppBar({
  tool,
  to,
  trail,
  children,
  account = true,
  onHome,
  className,
}: {
  tool: ReactNode;
  to?: string;
  /** After the tool: the project, post or file you're in. */
  trail?: ReactNode;
  /** The page's actions, left of the account menu. */
  children?: ReactNode;
  /** Off where the page shows its own (a public share page's sign-in). */
  account?: boolean;
  /** Caption Studio saves before it leaves. */
  onHome?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}) {
  return (
    <header
      data-titlebar
      className={cn(
        // a phone's actions wrap onto a second row instead of running over the title; on a desktop the bar is one
        // fixed-height row (every page the same height), the trail truncates and the actions never shrink
        "flex min-h-14 w-full shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-zinc-500/20 px-3 py-2 sm:h-14 sm:flex-nowrap sm:gap-x-3 sm:px-4",
        className,
      )}
    >
      <HomeLink onClick={onHome} />
      <HistoryArrows />
      <span aria-hidden className="h-4 w-px shrink-0 bg-zinc-500/30" />
      {/* its own width (flex-auto), so the actions move to a second row before it gets squeezed */}
      {/* data-page-title: the assistant reads "where you are" from it (lib/page-context.ts) */}
      <nav data-page-title className="flex min-w-0 flex-auto items-center gap-1.5 text-sm font-semibold tracking-tight">
        {to ? (
          <Link to={to} className={cn("max-w-[40%] shrink-0 truncate", trail && "text-zinc-500 hover:text-inherit")}>
            {tool}
          </Link>
        ) : (
          <h1 className="max-w-[40%] shrink-0 truncate">{tool}</h1>
        )}
        {trail && (
          <>
            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
            <span className="flex min-w-0 flex-1 items-center truncate">{trail}</span>
          </>
        )}
      </nav>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5 sm:shrink-0 sm:flex-nowrap sm:gap-2">
        {children}
        {account && <UserMenu />}
      </div>
    </header>
  );
}

/**
 * The tool's own heading under the AppBar, the same on every tool's start screen: the icon on the project's colour
 * (violet classes follow it), the name, one line.
 */
export function ToolIntro({
  icon: Icon,
  title,
  line,
  children,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  line: ReactNode;
  /** Right side: the start screen's one main action (Guide Builder's New). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-8 mt-10 flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-600">
        <Icon className="h-6 w-6 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-zinc-500">{line}</p>
      </div>
      {children}
    </div>
  );
}
