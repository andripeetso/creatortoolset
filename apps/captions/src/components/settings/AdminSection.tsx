import { Link, Navigate } from "react-router";
import { AdminPanel, type AdminTab } from "@/components/AdminPanel";
import { useAuth } from "@/lib/auth";
import { adminTabsFor, type PluginSettingsSection } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { cn } from "@/lib/utils";
import { ServerKeysTab } from "./ServerKeysTab";

export interface AdminTabItem {
  id: string;
  label: string;
}

const BUILT_IN: AdminTabItem[] = [
  { id: "users", label: "Accounts" },
  { id: "access", label: "Access" },
  { id: "projects", label: "Projects" },
];

/**
 * The Admin tabs for this person on this server: nothing for a non-admin; Server keys only on a hosted server (an
 * own-computer install has none); then the tabs a plug-in adds (adminTab), in plug-in order.
 */
export function adminTabList(me: { role: string } | null, hosted: boolean, plugins: Pick<PluginSettingsSection, "id" | "title">[]): AdminTabItem[] {
  if (me?.role !== "admin") return [];
  return [
    ...BUILT_IN,
    ...(hosted ? [{ id: "server-keys", label: "Server keys" }] : []),
    ...plugins.map((s) => ({ id: s.id, label: s.title })),
  ];
}

/** Tab ids that were renamed or retired: an old address goes to the tab that now holds it. */
const RETIRED_TAB: Record<string, string> = { ai: "server-keys", apps: "access" };

/** The tab an old address moves to, when that tab is on this server; null otherwise (the sub-id is then not a retired one). */
export function retiredTabTarget(sub: string | undefined, tabIds: readonly string[]): string | null {
  const to = sub ? RETIRED_TAB[sub] : undefined;
  return to && tabIds.includes(to) ? to : null;
}

/**
 * Settings → Admin (hosted servers, platform admins only): Accounts, Access, Projects, the server's keys, and the tabs a
 * plug-in adds (e.g. Footage). An unknown tab goes to Accounts; a retired tab id moves to its tab (ai → Server keys).
 */
export function AdminSection({ sub }: { sub?: string }) {
  const me = useAuth((s) => s.me);
  const hosted = useAuth((s) => s.hosted);
  const plugins = adminTabsFor(me, webPlugins);
  const tabs = adminTabList(me, hosted, plugins);
  const moved = retiredTabTarget(sub, tabs.map((t) => t.id));
  if (moved) return <Navigate to={`/settings/admin/${moved}`} replace />;
  const active = tabs.find((t) => t.id === sub) ?? tabs[0];
  if (!active) return null;
  const plugin = plugins.find((p) => p.id === active.id);
  return (
    <>
      <div role="tablist" aria-label="Admin" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.id}
            to={`/settings/admin/${t.id}`}
            role="tab"
            aria-selected={active.id === t.id}
            replace
            className={cn(
              "shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2 text-sm transition-colors",
              active.id === t.id ? "border-violet-500 font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      {plugin ? plugin.body : active.id === "server-keys" ? <ServerKeysTab /> : <AdminPanel tab={active.id as AdminTab} />}
    </>
  );
}
