import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { PacksBrowse } from "./PacksBrowse";
import { PacksFile } from "./PacksFile";
import { PacksInstalled } from "./PacksInstalled";
import { PacksShare } from "./PacksShare";

/** The sub-pages, as the URL names them: /settings/packs/<id>. */
const TABS = [
  { id: "installed", label: "Installed" },
  { id: "browse", label: "Browse" },
  { id: "file", label: "Install from file" },
  { id: "share", label: "Share as pack" },
] as const;

/** Settings → Packs: installed packs, the community catalog, installing a pack file, and sharing your own as one. */
export function PacksSection({ sub }: { sub?: string }) {
  const tab = TABS.find((t) => t.id === sub)?.id ?? "installed";
  const body = {
    installed: <PacksInstalled />,
    browse: <PacksBrowse />,
    file: <PacksFile />,
    share: <PacksShare />,
  }[tab];
  return (
    <>
      <nav aria-label="Packs" className="flex flex-wrap gap-1 border-b border-border pb-2">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={`/settings/packs/${t.id}`}
            replace
            aria-current={t.id === tab ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors",
              t.id === tab ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="mt-4">{body}</div>
    </>
  );
}
