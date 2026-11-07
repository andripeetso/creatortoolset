import { Link, Navigate, useLocation } from "react-router";
import { Cable, Cpu, FileDown, Gauge, KeyRound, Laptop, ListChecks, Monitor, Palette, SlidersHorizontal, UserRound, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AccountSection } from "@/components/settings/AccountSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { DevicesSection } from "@/components/settings/DevicesSection";
import { ExportsSection } from "@/components/settings/ExportsSection";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { ServiceKeysSection } from "@/components/settings/ServiceKeysSection";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { SetupSection } from "@/components/settings/SetupSection";
import { UsageSection } from "@/components/settings/UsageSection";
import { useMe } from "@/lib/auth";
import { cn } from "@/lib/utils";

/** The sections, in the order the sidebar shows them; API keys (the server's own keys) last, admins only. */
const SETTINGS_SECTIONS: ReadonlyArray<{ id: string; title: string; icon: LucideIcon; adminOnly?: boolean }> = [
  { id: "general", title: "General", icon: SlidersHorizontal },
  { id: "setup", title: "Setup", icon: ListChecks },
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "providers", title: "AI providers", icon: Cpu },
  { id: "connectors", title: "Connectors", icon: Cable },
  { id: "my-keys", title: "My API keys", icon: KeyRound },
  { id: "usage", title: "Usage", icon: Gauge },
  { id: "devices", title: "Devices", icon: Monitor },
  { id: "exports", title: "Exports", icon: FileDown },
  { id: "account", title: "Account", icon: UserRound },
  { id: "keys", title: "API keys", icon: KeyRound, adminOnly: true },
];

/** Inside the Mac app (apps/mac marks its page with html.mac-app): its own options open in a native panel. */
const macApp = () => typeof document !== "undefined" && document.documentElement.classList.contains("mac-app");
const openThisMac = () =>
  (window as unknown as { webkit?: { messageHandlers?: { window?: { postMessage: (m: string) => void } } } }).webkit?.messageHandlers?.window?.postMessage("this-mac");

/**
 * Settings, a modal
 * over the page you were on (a modal on top, not a full page). `/settings/:section/:sub?`; App keeps
 * the page behind it and `onClose` goes back to it.
 */
export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const [, , section = "general", sub] = useLocation().pathname.split("/");
  const me = useMe();
  // Packs moved to Community, a window of its own; old links land on what's installed
  if (section === "packs") return <Navigate to="/community/installed" replace />;
  const visible = SETTINGS_SECTIONS.filter((s) => !s.adminOnly || me?.role === "admin");
  const current = visible.find((s) => s.id === section);
  if (!current) return <Navigate to="/settings/general" replace />;

  const body = {
    general: <GeneralSection />,
    setup: <SetupSection />,
    appearance: <AppearanceSection />,
    providers: <ProvidersSection sub={sub} />,
    connectors: <ConnectorsSection />,
    "my-keys": <MyKeysSection />,
    usage: <UsageSection />,
    devices: <DevicesSection />,
    exports: <ExportsSection />,
    account: <AccountSection />,
    keys: <ServiceKeysSection />,
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
              <Link
                key={s.id}
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
            );
          })}
          {/* the Mac app's servers, AI on this Mac, the server here and its data: a native panel, not a page */}
          {macApp() && (
            <button
              type="button"
              onClick={openThisMac}
              className="flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground md:mt-2 md:border-t md:border-border md:pt-2.5"
            >
              <Laptop className="h-4 w-4" />
              This Mac
            </button>
          )}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <h1 className="text-lg font-semibold tracking-tight">{current.title}</h1>
          <div className="mt-2">{body}</div>
        </main>
      </DialogContent>
    </Dialog>
  );
}
