import type { InstalledPack } from "@contracts/packs";
import { Link } from "react-router";
import type { UpdateRow } from "@contracts/pack-catalog";
import { Card, Loading, Notice } from "../settings/ui";
import { ContentsSummary, ContentsView } from "./PacksShared";
import { packProjects } from "./packs-helpers";
import { PackActions } from "./PackActions";
/** Installed: what each pack adds, on/off, the projects it's in, update, remove. */
export function InstalledView({
  installed,
  updates,
  reload,
  error,
}: {
  installed: InstalledPack[] | null;
  updates: UpdateRow[];
  reload: () => Promise<void>;
  error: string | null;
}) {
  if (!installed) return error ? <Notice tone="error">{error}</Notice> : <Loading />;
  return (
    <>
      {error && <div className="mb-3"><Notice tone="error">{error}</Notice></div>}
      {installed.length === 0 ? (
        <Notice>
          Nothing installed yet. <Link to="/community/explore" className="underline">Explore</Link> what people have made.
        </Notice>
      ) : (
        <Card>
          {installed.map((p) => (
            <PackRow key={p.id} pack={p} latest={updates.find((u) => u.id === p.id)?.latest} reload={reload} />
          ))}
        </Card>
      )}
    </>
  );
}
function PackRow({ pack: p, latest, reload }: { pack: InstalledPack; latest?: string | null; reload: () => Promise<void> }) {
  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{p.name}</span>
        <span className="text-xs text-muted-foreground">v{p.version}</span>
        {p.default && (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Default</span>
        )}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        by {p.author} · {p.license}
        {packProjects(p).length > 0 && ` · ${packProjects(p).length === 1 ? "1 project" : `${packProjects(p).length} projects`}`}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
      {p.default && (
        <p className="mt-1 text-xs text-muted-foreground">
          {p.off.includes("*")
            ? "The team's starting pack. It's off for your account because you had your own setup before packs; switch it on to try it."
            : "The team's starting pack, on for you now. Switch it off or remove it to use a community pack instead."}
        </p>
      )}
      <div className="mt-1 text-xs text-muted-foreground">
        Adds: <ContentsSummary pack={p} />
      </div>
      {p.held?.designSystems && (
        <div className="mt-2">
          <Notice>
            {p.held.designSystems.items.length} design {p.held.designSystems.items.length === 1 ? "system" : "systems"} from this pack{" "}
            {p.held.designSystems.needs === "plug-in" ? "need a plug-in on this server to install" : "need an admin to install"}. They are kept with the pack.
          </Notice>
        </div>
      )}
      {p.delisted && (
        <div className="mt-2">
          <Notice tone="error">Pulled from the community: {p.delisted}. Its instructions are off.</Notice>
        </div>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground underline">What it adds</summary>
        <div className="mt-2">
          <ContentsView pack={p} />
        </div>
      </details>
      <div className="mt-3">
        <PackActions id={p.id} name={p.name} installed={p} latest={latest} reload={reload} />
      </div>
    </div>
  );
}
