import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { BarChart3, Compass, Layers, Package, PenLine, Scissors, Search, Type, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Card, ErrorRow, LoadingRow } from "@/components/settings/ui";
import { PACK_KINDS, packKinds, type KindId } from "@/components/community/packs-helpers";
import { ExploreView, KindView } from "@/components/community/CatalogViews";
import { InstalledView } from "@/components/community/PacksInstalled";
import { PackDetailView } from "@/components/community/PackDetailView";
import { useCommunityData } from "@/components/community/useCommunityData";
import { useAuth, useMe } from "@/lib/auth";
import { mergePluginInfo } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";

const KIND_ICONS: Record<KindId, LucideIcon> = {
  frameworks: Layers,
  guides: PenLine,
  captions: Type,
  editing: Scissors,
  analyzer: BarChart3,
};
const KINDS = Object.keys(PACK_KINDS) as KindId[];
const SECTIONS = ["explore", ...KINDS, "installed"];

// The sidebar item of Settings (SettingsPage.tsx itemCls), so the two windows read as one family.
const itemCls = (on: boolean) =>
  cn(
    "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:w-full",
    on ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
  );

/**
 * Community: its own window over the page behind it, from the account menu, at /community/<section>: the shared catalog by
 * the place a pack works in, and what's installed (the plug-ins this server is built with, then the packs).
 * /community/pack/<id> is one pack. The frame is Settings' frame: a header with the breadcrumb, a sidebar, a content column.
 */
export default function CommunityPage({ onClose }: { onClose: () => void }) {
  const [, , section = "explore", sub] = useLocation().pathname.split("/");
  const navigate = useNavigate();
  const data = useCommunityData();
  const me = useMe();
  const hosted = useAuth((s) => s.hosted);
  const [q, setQ] = useState("");
  const isCatalog = section === "explore" || (KINDS as string[]).includes(section);
  if (section !== "pack" && !SECTIONS.includes(section)) return <Navigate to="/community/explore" replace />;
  const installed = data.installed ?? [];
  const plugins = mergePluginInfo(webPlugins, data.serverPlugins, { me, hosted });
  const waiting = data.updates.length;
  const title =
    section === "pack" ? "Pack" : section === "installed" ? "Installed" : section === "explore" ? "Explore" : PACK_KINDS[section as KindId];
  const nav = (id: string, label: string, Icon: LucideIcon, count?: number, dot = false) => {
    const on = section === id;
    return (
      <Link key={id} to={`/community/${id}`} replace aria-current={on ? "page" : undefined} className={itemCls(on)}>
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {dot && <span aria-label="Updates waiting" className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
        {count !== undefined && <span className="text-xs text-sidebar-foreground/60">{count}</span>}
      </Link>
    );
  };
  const catalogWaiting = data.catalog === null;
  const body =
    section === "pack" ? (
      <PackDetailView id={sub ?? ""} installed={installed.find((p) => p.id === sub)} reload={data.reload} />
    ) : section === "installed" ? (
      <InstalledView plugins={plugins} folderPlugins={data.folderPlugins} installed={data.installed} updates={data.updates} reload={data.reload} error={data.error} />
    ) : catalogWaiting ? (
      <Card>
        {data.catalogError ? <ErrorRow title="The Community catalog did not load" detail={data.catalogError} retry={data.reload} /> : <LoadingRow />}
      </Card>
    ) : section === "explore" ? (
      <ExploreView entries={data.catalog ?? []} installed={installed} updates={data.updates} q={q} reload={data.reload} />
    ) : (
      <KindView kind={section as KindId} entries={data.catalog ?? []} installed={installed} updates={data.updates} q={q} reload={data.reload} />
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // focus the dialog itself, as Settings does: opening it drew a focus ring on the search field
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        className="flex h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:h-[min(60rem,calc(100dvh-3rem))] sm:w-[min(80rem,calc(100vw-3rem))] sm:max-w-none sm:rounded-2xl sm:border sm:shadow-2xl lg:h-[min(60rem,calc(100dvh-5rem))] lg:w-[min(80rem,calc(100vw-5rem))]"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-3">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-normal">
            <span className="text-muted-foreground">Community</span>{" "}
            <span aria-hidden className="text-muted-foreground/60">
              ›
            </span>{" "}
            <span className="font-medium text-foreground">{title}</span>
          </DialogTitle>
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
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* the Settings sidebar's shape: search at the top, then the sections */}
          <div className="shrink-0 border-b border-border bg-sidebar p-2 text-sidebar-foreground md:w-60 md:border-b-0 md:border-e">
            <label className="relative mb-2 block">
              <Search aria-hidden className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  if (!isCatalog) navigate("/community/explore", { replace: true });
                }}
                placeholder="Search Community"
                aria-label="Search Community"
                className="h-8 w-full rounded-md border border-border/60 bg-background/50 ps-8 pe-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <nav aria-label="Community sections" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              <span className="hidden px-2.5 pb-1 text-xs font-medium text-sidebar-foreground/60 md:block">Discover</span>
              {nav("explore", "Explore", Compass, data.catalog?.length)}
              {KINDS.map((id) =>
                nav(id, PACK_KINDS[id], KIND_ICONS[id], data.catalog?.filter((e) => packKinds(e.contains).some((k) => k.id === id)).length),
              )}
              <span className="hidden px-2.5 pb-1 pt-4 text-xs font-medium text-sidebar-foreground/60 md:block">You</span>
              {nav("installed", "Installed", Package, data.installed ? installed.length + plugins.length : undefined, waiting > 0)}
            </nav>
          </div>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-scroll">
            <div className="mx-auto w-full max-w-4xl space-y-8 px-5 pt-6 pb-24 sm:px-6 sm:pb-12">{body}</div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
