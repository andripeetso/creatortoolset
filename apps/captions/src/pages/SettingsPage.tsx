import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PAGE_BODIES } from "@/components/settings/pages";
import { AccountAvatar } from "@/components/settings/AccountSection";
import { navBlocks, navListFor, resolveSection, sectionsFor, type NavContext, type SettingsPageId } from "@/components/settings/nav";
import { PageActionContext } from "@/components/settings/page-action";
import { searchSettings, type SearchHit } from "@/components/settings/search";
import { hasThisMac } from "@/components/settings/ThisMacSection";
import { HOME_TILE_NAMES, isHomeTile } from "@contracts/tools";
import { logout, useAuth, useMe } from "@/lib/auth";
import { cn } from "@/lib/utils";

const inDock = (t: EventTarget | null) => t instanceof Element && !!t.closest("[data-assistant-dock]");
/** Another layer on top of Settings (a toast, a confirm, another dialog): a click there does not close Settings. */
const inOtherLayer = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-sonner-toaster], [role="alertdialog"], [role="dialog"]');

/** One sidebar item. The active one is the only one with a background; hover and focus never look selected. */
const itemCls = (on: boolean, railOpen: boolean) =>
  cn(
    "flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
    on ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
    !railOpen && "max-md:justify-center max-md:px-0",
  );

/**
 * Settings: a modal over the page you were on, `/settings/:section/:sub?`. Non-modal, so the assistant dock stays usable
 * (see the comment on the Dialog). The nav is the sections this install and person may open; search indexes every row
 * (search.ts); a result opens `/settings/<section>#<row id>`, which lands on the row.
 */
export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const { pathname, hash, search } = useLocation();
  const navigate = useNavigate();
  const [, , section = "general", sub] = pathname.split("/");
  const me = useMe();
  const hosted = useAuth((s) => s.hosted);
  const required = useAuth((s) => s.required);
  const ctx: NavContext = { hosted, admin: me?.role === "admin", mac: hasThisMac() };

  const [query, setQuery] = useState("");
  const [railOpen, setRailOpen] = useState(false); // below md: the 56px icon rail, or the nav opened over the page
  const [active, setActive] = useState(0);
  const [actionEl, setActionEl] = useState<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const openSearch = () => {
    setRailOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  // "/" and Ctrl/⌘F focus the search, unless a field already has the keyboard
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const find = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f";
      if (!find && (e.key !== "/" || t?.closest("input, textarea, select, [contenteditable='true']"))) return;
      e.preventDefault();
      setRailOpen(true);
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A search result: scroll its row to the middle, focus it and pulse it once, then clear the #hash so a reload stays put.
  // Retries briefly, since a section's rows can mount a moment after the page opens.
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (!id) return;
    let tries = 0;
    let timer = 0;
    const land = () => {
      const el = document.querySelector<HTMLElement>(`[data-settings-row="${CSS.escape(id)}"]`);
      if (el && el.getClientRects().length > 0) {
        el.tabIndex = -1;
        el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        el.focus({ preventScroll: true });
        el.classList.add("settings-search-target");
        window.setTimeout(() => el.classList.remove("settings-search-target"), 700);
      } else if (++tries < 20) {
        timer = window.setTimeout(land, 100);
        return;
      }
      navigate({ pathname, search }, { replace: true });
    };
    land();
    return () => window.clearTimeout(timer);
  }, [pathname, hash, search, navigate]);

  // Old ids, and sections this install or person does not show, go elsewhere (nav.ts)
  const resolved = resolveSection(section, ctx);
  if (resolved.kind === "redirect") return <Navigate to={resolved.to} replace />;

  const entries = sectionsFor(ctx);
  const current = entries.find((s) => s.id === resolved.id)!;
  // a plug-in section brings its own body; a built-in one is drawn by its page (pages.tsx)
  const Page = (PAGE_BODIES as Partial<Record<string, ComponentType<{ sub?: string }>>>)[current.id as SettingsPageId];
  const body = current.body ?? (Page ? <Page sub={sub} /> : null);

  const navList = navListFor(ctx);
  const needle = query.trim();
  const hits = needle ? searchSettings(needle, new Map(entries.map((s) => [s.id, s.title])), undefined, required, ctx.mac) : [];
  const activeIdx = Math.min(active, Math.max(hits.length - 1, 0));
  const name = me?.name ?? me?.username ?? "";
  const initial = (name.trim()[0] ?? "?").toUpperCase();

  const openHit = (hit: SearchHit) => {
    setQuery("");
    setRailOpen(false);
    setActive(0);
    navigate({ pathname: `/settings/${hit.section}`, hash: hit.id ? `#${hit.id}` : "" }, { replace: true });
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) {
      e.preventDefault();
      setActive(e.key === "ArrowDown" ? Math.min(activeIdx + 1, hits.length - 1) : Math.max(activeIdx - 1, 0));
    } else if (e.key === "Enter" && hits[activeIdx]) {
      e.preventDefault();
      openHit(hits[activeIdx]);
    }
  };

  // Arrow keys move between the sidebar items (one tab stop for the whole nav)
  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    const items = Array.from(navRef.current?.querySelectorAll<HTMLElement>("[data-nav-item]") ?? []);
    const i = items.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    let next: number;
    switch (e.key) {
      case "ArrowDown": next = i + 1; break;
      case "ArrowUp": next = i - 1; break;
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      default: return;
    }
    e.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  };

  // Not modal, so the assistant's dock (above this, AssistantDock.tsx) can be clicked and typed in while Settings is open;
  // the backdrop is drawn here since a non-modal dialog has none. A click outside still closes Settings, but not one in the
  // dock or on another layer (a toast, a confirm), and focus moving out never does.
  return (
    <Dialog open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <div aria-hidden className="fixed inset-0 z-50 bg-black/50 motion-safe:animate-in motion-safe:fade-in-0" />
      </DialogPortal>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onFocusOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => (inDock(e.target) || inOtherLayer(e.target)) && e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (inDock(document.activeElement)) e.preventDefault();
          else if (query) {
            e.preventDefault();
            setQuery("");
          } else if (railOpen && window.matchMedia("(max-width: 767.98px)").matches) {
            // below md the nav opened over the page: Esc folds it back to the rail (on a wide screen there is no rail)
            e.preventDefault();
            setRailOpen(false);
          }
        }}
        // focus the dialog itself, not its first button: opening Settings drew a focus ring round the close button
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        className="flex h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:h-[min(60rem,calc(100dvh-3rem))] sm:w-[min(80rem,calc(100vw-3rem))] sm:max-w-none sm:rounded-2xl sm:border sm:shadow-2xl lg:h-[min(60rem,calc(100dvh-5rem))] lg:w-[min(80rem,calc(100vw-5rem))]"
      >
        <div className="relative flex min-h-0 flex-1">
          <nav
            ref={navRef}
            aria-label="Settings sections"
            onKeyDown={onNavKey}
            className={cn(
              "flex min-h-0 shrink-0 flex-col border-e bg-sidebar p-2 text-sidebar-foreground md:relative md:w-60",
              railOpen ? "absolute inset-y-0 start-0 z-10 w-full" : "w-14",
            )}
          >
            <button
              type="button"
              aria-label="Search settings"
              onClick={openSearch}
              className={cn("mb-2 flex h-8 w-full items-center justify-center rounded-md text-sidebar-foreground/80 outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring md:hidden", railOpen && "hidden")}
            >
              <Search className="size-4" aria-hidden />
            </button>
            <label className={cn("relative mb-3 block shrink-0", !railOpen && "max-md:hidden")}>
              <Search aria-hidden className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                role="combobox"
                aria-label="Search settings"
                aria-expanded={!!needle}
                aria-controls="settings-results"
                aria-activedescendant={needle && hits[activeIdx] ? `settings-result-${activeIdx}` : undefined}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKey}
                placeholder="Search settings"
                className="h-8 w-full rounded-md border border-border/60 bg-background/50 ps-8 pe-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
              {!needle && (
                <kbd aria-hidden className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 rounded border border-border px-1 text-[11px] text-muted-foreground">
                  /
                </kbd>
              )}
            </label>

            {/* both lists always keep their scrollbar's 8px, in the rail's own right padding (-me-2): nothing moves when one starts to scroll */}
            {needle ? (
              <ul id="settings-results" role="listbox" aria-label="Results" className="-me-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-scroll">
                {hits.map((hit, i) => (
                  <li
                    key={`${hit.section}#${hit.id ?? ""}`}
                    id={`settings-result-${i}`}
                    role="option"
                    aria-selected={i === activeIdx}
                    onMouseMove={() => setActive(i)}
                    onClick={() => openHit(hit)}
                    className={cn("cursor-pointer rounded-md px-2.5 py-1.5", i === activeIdx && "bg-sidebar-accent text-sidebar-accent-foreground")}
                  >
                    <div className="truncate text-sm font-medium">{hit.title}</div>
                    <div className="truncate text-xs text-sidebar-foreground/60">{hit.sectionTitle}</div>
                  </li>
                ))}
                {!hits.length && (
                  <li role="status" className="px-2.5 py-6 text-center text-xs text-sidebar-foreground/60">
                    No settings found
                  </li>
                )}
              </ul>
            ) : (
              <div className="-me-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-scroll">
                {navBlocks(navList).map((block, bi) => (
                  <div key={bi} className={cn("flex flex-col gap-0.5", bi > 0 && "mt-4")}>
                    {block.heading && (
                      <span className={cn("px-2.5 pb-1 text-xs font-medium text-sidebar-foreground/60", !railOpen && "max-md:hidden")}>{block.heading}</span>
                    )}
                    {block.items.map((s) => {
                      const SectionIcon = s.icon;
                      const on = s.id === current.id;
                      return (
                        <Link
                          key={s.id}
                          to={`/settings/${s.id}`}
                          replace
                          data-nav-item
                          tabIndex={on ? 0 : -1}
                          aria-current={on ? "page" : undefined}
                          onClick={() => {
                            setQuery("");
                            setRailOpen(false);
                          }}
                          className={itemCls(on, railOpen)}
                        >
                          <SectionIcon className="size-4 shrink-0" aria-hidden />
                          <span className={cn("truncate", !railOpen && "max-md:sr-only")}>{s.title}</span>
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}

            {/* The account: its entry is this button (the Account page is not in the list) */}
            <div className="mt-auto shrink-0 border-t border-border/50 pt-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-nav-item
                    tabIndex={current.id === "account" ? 0 : -1}
                    aria-label={`Account: ${name}`}
                    aria-current={current.id === "account" ? "page" : undefined}
                    className={itemCls(current.id === "account", railOpen)}
                  >
                    <AccountAvatar picture={me?.picture} initial={initial} className="size-5 text-[11px]" />
                    <span className={cn("min-w-0 truncate", !railOpen && "max-md:sr-only")}>{name}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-64">
                  <DropdownMenuLabel className="flex items-center gap-3 px-2 py-2 font-normal">
                    <AccountAvatar picture={me?.picture} initial={initial} className="size-8 text-xs" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{me?.username}</span>
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => navigate("/settings/account", { replace: true })} className="text-sm">
                    Manage account
                  </DropdownMenuItem>
                  {required && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => void logout()} className="text-sm">
                        Sign out
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </nav>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
              <DialogTitle className="min-w-0 flex-1 truncate text-sm font-normal">
                <span className="text-muted-foreground">Settings</span>{" "}
                <span aria-hidden className="text-muted-foreground/60">
                  ›
                </span>{" "}
                {current.id === "tools" && sub && isHomeTile(sub) ? (
                  <>
                    <Link to="/settings/tools" replace className="text-muted-foreground hover:text-foreground">
                      {current.title}
                    </Link>{" "}
                    <span aria-hidden className="text-muted-foreground/60">
                      ›
                    </span>{" "}
                    <span className="font-medium text-foreground">{HOME_TILE_NAMES[sub]}</span>
                  </>
                ) : (
                  <span className="font-medium text-foreground">{current.title}</span>
                )}
              </DialogTitle>
              <div ref={setActionEl} className="flex shrink-0 items-center gap-2 empty:hidden" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <DialogClose asChild>
                    <Button variant="ghost" size="icon-xs" aria-label="Close">
                      <X />
                    </Button>
                  </DialogClose>
                </TooltipTrigger>
                <TooltipContent>Close (Esc)</TooltipContent>
              </Tooltip>
            </header>
            <PageActionContext.Provider value={actionEl}>
              <div className="min-h-0 flex-1 overflow-y-scroll">
                <div className="mx-auto max-w-4xl space-y-8 px-5 pt-6 pb-24 sm:px-6 sm:pb-12">{body}</div>
              </div>
            </PageActionContext.Provider>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
