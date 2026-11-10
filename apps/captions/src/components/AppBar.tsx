import { Fragment, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { HistoryArrows, HomeLink } from "@/components/HomeLink";
import { UserMenu } from "@/components/UserMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMe } from "@/lib/auth";
import { isPhoneHub } from "@/lib/mobile";
import { OTHER, WORKFLOW, useOpenTool } from "@/lib/tools";
import { cn } from "@/lib/utils";

/**
 * The bar on top of every tool and Home: the logo home, the tool (a menu of every tool; its own entry goes back to its
 * start when `to` is set), where you are in it, the page's actions, then the account menu.
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
  /** None on Home: the bar is only the name, the arrows and the account. */
  tool?: ReactNode;
  /** The tool's start, when the page is somewhere inside it: the tool menu's own entry goes there. */
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
    <>
    <header
      data-titlebar
      data-appbar
      className={cn(
        // a phone's actions wrap onto a second row instead of running over the title; on a desktop the bar is one
        // fixed-height row (every page the same height), the trail truncates and the actions never shrink.
        // From tablet width up it stays put while the page scrolls under it: that, and its colour, are in index.css
        // ([data-appbar]) at zero specificity, so a page's own classes here win
        "flex min-h-14 w-full shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 sm:h-14 sm:flex-nowrap sm:gap-x-3 sm:px-4",
        className,
      )}
    >
      <HomeLink onClick={onHome} />
      <HistoryArrows />
      {/* its own width (flex-auto), so the actions move to a second row before it gets squeezed */}
      {/* data-page-title: the assistant reads "where you are" from it (lib/page-context.ts) */}
      <nav data-page-title className="flex min-w-0 flex-auto items-center gap-1.5 text-sm font-semibold tracking-tight">
        {tool !== undefined && <ToolMenu tool={tool} to={to} dim={!!trail} onLeave={onHome} />}
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
    {/* the page fades out directly under the bar once it has scrolled (index.css); below anything else that sticks */}
    <div aria-hidden data-appbar-fade className="fixed inset-x-0 top-[var(--bar-h)] z-[5] hidden sm:block" />
    </>
  );
}

/** The tool's name opens every tool you may use, to jump straight to another; the one you're in takes you to its
 *  start. Signed out (a share page) it is just the name. */
function ToolMenu({ tool, to, dim, onLeave }: {
  tool: ReactNode;
  to?: string;
  dim: boolean;
  onLeave?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const me = useMe();
  const { pathname } = useLocation();
  const openTool = useOpenTool();
  const name = cn("max-w-[40%] shrink-0 truncate", dim && "text-zinc-500");
  if (!me) return <h1 className={name}>{tool}</h1>;
  const phone = isPhoneHub();
  const groups = [WORKFLOW.flatMap((s) => s.tools), OTHER].map((g) => g.filter((t) => t.can(me))).filter((g) => g.length);
  const here = (path: string) => {
    const base = path.split("?")[0];
    return pathname === base || pathname.startsWith(`${base}/`);
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className={cn(name, "-mx-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 outline-none hover:bg-zinc-500/15 data-[state=open]:bg-zinc-500/15")}>
        <h1 className="truncate">{tool}</h1>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {groups.map((g, i) => (
          <Fragment key={i}>
            {i > 0 && <DropdownMenuSeparator />}
            {g.map((t) => {
              const current = here(t.to);
              const dest = current && to ? to : phone && t.phoneTo ? t.phoneTo : t.to;
              return (
                <DropdownMenuItem key={t.to} asChild>
                  <Link
                    to={dest}
                    onClick={(e) => {
                      if (!current) onLeave?.(e);
                      openTool(e, dest);
                    }}
                  >
                    <t.icon className="h-4 w-4 text-violet-400" />
                    <span className="flex-1">{t.name}</span>
                    {current && <Check className="h-4 w-4 text-zinc-500" />}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
