import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { Advanced, Card, ListRow, Status } from "@/components/settings/ui";
import type { PluginAdd, PluginInfo } from "@/lib/plugin";

/**
 * The plug-ins this server is built with, one row each. "What it adds" folds the list, and each line that has a place
 * is a link: it closes Community and opens that place (Settings, Home, a page). Nothing here can be removed.
 */
export function PluginRows({ plugins }: { plugins: PluginInfo[] }) {
  return (
    <Card>
      {plugins.map((p) => (
        <div key={p.id} className="[&>*+*]:border-t [&>*+*]:border-border/50">
          <ListRow title={p.name} subtitle={p.about} status={<Status>Built into this server</Status>} />
          {p.adds.length > 0 && <Advanced summary="What it adds">{p.adds.map((a) => <AddLine key={a.text} add={a} />)}</Advanced>}
        </div>
      ))}
    </Card>
  );
}

function AddLine({ add }: { add: PluginAdd }) {
  if (!add.to) return <div className="py-2 text-sm text-muted-foreground">{add.text}</div>;
  return (
    <Link to={add.to} className="flex items-center justify-between gap-3 py-2 text-sm text-foreground underline-offset-2 hover:underline">
      <span className="min-w-0 truncate">{add.text}</span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}
