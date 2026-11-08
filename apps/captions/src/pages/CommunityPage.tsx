import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { BarChart3, Compass, Layers, Package, PenLine, Scissors, Type, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, FROM_TOP_RIGHT } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Loading, Notice } from "@/components/settings/ui";
import { PACK_KINDS, packKinds, type KindId } from "@/components/community/packs-helpers";
import { ExploreView, KindView } from "@/components/community/CatalogViews";
import { InstalledView } from "@/components/community/PacksInstalled";
import { PackDetailView } from "@/components/community/PackDetailView";
import { useCommunityData } from "@/components/community/useCommunityData";

const KIND_ICONS: Record<KindId, LucideIcon> = {
  frameworks: Layers,
  guides: PenLine,
  captions: Type,
  editing: Scissors,
  analyzer: BarChart3,
};
const KINDS = Object.keys(PACK_KINDS) as KindId[];
const SECTIONS = ["explore", ...KINDS, "installed"];
/**
 * Community: its own window over the page behind it, from the account menu, at /community/<section>: the shared
 * catalog by the place a pack works in, and what's installed. /community/pack/<id> is one pack.
 */
export default function CommunityPage({ onClose }: { onClose: () => void }) {
  const [, , section = "explore", sub] = useLocation().pathname.split("/");
  const navigate = useNavigate();
  const data = useCommunityData();
  const [q, setQ] = useState("");
  const isCatalog = section === "explore" || (KINDS as string[]).includes(section);
  if (section !== "pack" && !SECTIONS.includes(section)) return <Navigate to="/community/explore" replace />;
  const installed = data.installed ?? [];
  const waiting = data.updates.length;
  const nav = (id: string, label: string, Icon: LucideIcon, count?: number, dot = false) => {
    const on = section === id;
    return (
      <Link
        key={id}
        to={`/community/${id}`}
        replace
        aria-current={on ? "page" : undefined}
        className={cn(
          "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
          on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {dot && <span aria-label="Updates waiting" className="h-2 w-2 rounded-full bg-amber-500" />}
        {count !== undefined && <span className="text-[11px] text-muted-foreground">{count}</span>}
      </Link>
    );
  };
  const body =
    section === "pack" ? (
      <PackDetailView id={sub ?? ""} installed={installed.find((p) => p.id === sub)} reload={data.reload} />
    ) : section === "installed" ? (
      <InstalledView installed={data.installed} updates={data.updates} reload={data.reload} error={data.error} />
    ) : data.catalog === null ? (
      data.catalogError ? <Notice tone="error">{data.catalogError}</Notice> : <Loading />
    ) : section === "explore" ? (
      <ExploreView entries={data.catalog} installed={installed} updates={data.updates} q={q} />
    ) : (
      <KindView kind={section as KindId} entries={data.catalog} installed={installed} updates={data.updates} q={q} />
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent style={FROM_TOP_RIGHT} className="flex h-[min(900px,calc(100dvh-2rem))] w-[min(1240px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3 pl-4 pr-12 md:px-5">
          <DialogTitle className="text-base font-semibold">Community</DialogTitle>
          <Input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!isCatalog) navigate("/community/explore", { replace: true });
            }}
            placeholder="Search Community"
            aria-label="Search Community"
            className="order-last w-full sm:order-none sm:ml-auto sm:w-72"
          />
        </header>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label="Community sections"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-3 md:w-52 md:flex-col md:overflow-visible md:border-b-0 md:border-r"
          >
            <span className="hidden px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground md:block">Discover</span>
            {nav("explore", "Explore", Compass, data.catalog?.length)}
            {KINDS.map((id) =>
              nav(
                id,
                PACK_KINDS[id],
                KIND_ICONS[id],
                data.catalog?.filter((e) => packKinds(e.contains).some((k) => k.id === id)).length,
              ),
            )}
            <span className="hidden px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground md:block">You</span>
            {nav("installed", "Installed", Package, data.installed ? installed.length : undefined, waiting > 0)}
          </nav>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6">{body}</main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
