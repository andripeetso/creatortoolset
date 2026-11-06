import { Fragment } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Cable, Cpu, Gauge, KeyRound, Monitor, Palette, ShieldCheck, SlidersHorizontal, UserRound, Users, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AccountSection } from "@/components/settings/AccountSection";
import { AdminSection } from "@/components/settings/AdminSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { DevicesSection } from "@/components/settings/DevicesSection";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { ServiceKeysSection } from "@/components/settings/ServiceKeysSection";
import { UsageSection } from "@/components/settings/UsageSection";
import { WorkspaceSection } from "@/components/settings/WorkspaceSection";
import { useViewedMe } from "@/lib/auth";
import { cn } from "@/lib/utils";

/**
 * The sections, in the order the sidebar shows them: the account's own, then the Workspace group pinned at the bottom:
 * Team (the workspace: members, invites, their AI; any account), then API keys and Server (the platform operator, admins only).
 */
const SETTINGS_SECTIONS: ReadonlyArray<{ id: string; title: string; icon: LucideIcon; adminOnly?: boolean; workspace?: boolean }> = [
  { id: "general", title: "General", icon: SlidersHorizontal },
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "providers", title: "AI providers", icon: Cpu },
  { id: "connectors", title: "Connectors", icon: Cable },
  { id: "usage", title: "Usage", icon: Gauge },
  { id: "devices", title: "Devices", icon: Monitor },
  { id: "account", title: "Account", icon: UserRound },
  { id: "team", title: "Team", icon: Users, workspace: true },
  { id: "keys", title: "API keys", icon: KeyRound, adminOnly: true, workspace: true },
  { id: "admin", title: "Server", icon: ShieldCheck, adminOnly: true, workspace: true },
];

/**
 * Settings, a modal
 * over the page you were on (a modal on top, not a full page). `/settings/:section/:sub?`; App keeps
 * the page behind it and `onClose` goes back to it.
 */
export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const [, , section = "general", sub] = useLocation().pathname.split("/");
  const me = useViewedMe();
  const account = !!me && me.role !== "guest" && !me.demo;
  const visible = SETTINGS_SECTIONS.filter((s) => (!s.adminOnly || me?.role === "admin") && (s.id !== "team" || account));
  const current = visible.find((s) => s.id === section);
  if (!current) return <Navigate to="/settings/general" replace />;

  const body = {
    general: <GeneralSection />,
    appearance: <AppearanceSection />,
    providers: <ProvidersSection sub={sub} />,
    connectors: <ConnectorsSection />,
    usage: <UsageSection />,
    devices: <DevicesSection />,
    account: <AccountSection />,
    team: <WorkspaceSection />,
    keys: <ServiceKeysSection />,
    admin: <AdminSection sub={sub} />,
  }[current.id];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(860px,calc(100dvh-2rem))] w-[min(1100px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none md:flex-row">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-3 md:w-52 md:flex-col md:overflow-visible md:border-b-0 md:border-r">
          <span className="hidden px-2.5 pb-2 pt-1 text-sm font-semibold md:block">Settings</span>
          {visible.map((s) => {
            const Icon = s.icon;
            const on = s.id === current.id;
            return (
              <Fragment key={s.id}>
                {s.workspace && s === visible.find((x) => x.workspace) && <span className="hidden px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground md:mt-auto md:block">Workspace</span>}
                <Link
                  to={`/settings/${s.id}`}
                  replace
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {s.title}
                </Link>
              </Fragment>
            );
          })}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <h1 className="text-lg font-semibold tracking-tight">{current.title}</h1>
          <div className="mt-2">{body}</div>
        </main>
      </DialogContent>
    </Dialog>
  );
}
