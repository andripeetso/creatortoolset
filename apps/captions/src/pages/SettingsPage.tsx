import { Fragment } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Cable, CalendarClock, Cpu, Gauge, KeyRound, ListChecks, Monitor, Palette, SlidersHorizontal, UserRound, X, type LucideIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AccountSection } from "@/components/settings/AccountSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { AutomationsSection } from "@/components/settings/AutomationsSection";
import { DevicesSection } from "@/components/settings/DevicesSection";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { ServiceKeysSection } from "@/components/settings/ServiceKeysSection";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { SetupSection } from "@/components/settings/SetupSection";
import { UsageSection } from "@/components/settings/UsageSection";
import { useMe } from "@/lib/auth";
import { cn } from "@/lib/utils";

/**
 * The sections, in the order the sidebar shows them. `group` starts a labelled block; the "Server" block (the server's
 * own API keys, admins only) is pinned to the bottom. `blurb` is the one line under the title: only what the title
 * doesn't say. This Mac is not here: the Mac app's Servers menu opens it.
 */
const SETTINGS_SECTIONS: ReadonlyArray<{ id: string; title: string; blurb?: string; icon: LucideIcon; group?: string; adminOnly?: boolean }> = [
  { id: "general", title: "General", blurb: "How the app behaves on this device.", icon: SlidersHorizontal },
  { id: "setup", title: "Setup", blurb: "Your AI, accounts, a first project and your knowledge, one step at a time.", icon: ListChecks },
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "account", title: "Account", blurb: "Your name, password and AI access key.", icon: UserRound },
  { id: "providers", title: "AI providers", blurb: "The coding tools on your Macs that answer your AI.", icon: Cpu, group: "AI" },
  { id: "devices", title: "Devices", blurb: "The computers that run your AI.", icon: Monitor },
  { id: "usage", title: "Usage", blurb: "How much of each AI plan is left, and what the app used.", icon: Gauge },
  { id: "automations", title: "Automations", blurb: "Prompts the assistant runs on a schedule. Results go to your inbox.", icon: CalendarClock },
  { id: "connectors", title: "Connectors", blurb: "Your accounts, and the Apify key that reads the rest.", icon: Cable, group: "Data" },
  { id: "my-keys", title: "My API keys", blurb: "Your own keys for the paid services the tools call.", icon: KeyRound },
  { id: "keys", title: "API keys", blurb: "The server's own keys. They serve you, never your AI; other accounts use their own (My API keys).", icon: KeyRound, adminOnly: true, group: "Server" },
];

/**
 * Settings: a modal over the page you were on, `/settings/:section/:sub?`. App keeps the page behind it and `onClose`
 * goes back to it. The title row holds the close button, so nothing ever scrolls under it.
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
    automations: <AutomationsSection />,
    account: <AccountSection />,
    keys: <ServiceKeysSection />,
  }[current.id];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        // focus the dialog itself, not its first button: opening Settings drew a focus ring round the close button
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        className="flex h-[min(860px,calc(100dvh-2rem))] w-[min(1100px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none md:flex-row">
        <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-3 md:w-60 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
          <span className="hidden px-2 pb-2 pt-1 text-sm font-semibold md:block">Settings</span>
          {visible.map((s, i) => {
            const Icon = s.icon;
            const on = s.id === current.id;
            const heading = s.group && s.group !== visible[i - 1]?.group;
            return (
              <Fragment key={s.id}>
                {heading && (
                  <span className={cn("hidden px-2 pb-1 pt-4 text-xs font-medium text-muted-foreground/80 md:block", s.group === "Server" && "md:mt-auto")}>
                    {s.group}
                  </span>
                )}
                <Link
                  to={`/settings/${s.id}`}
                  replace
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm transition-colors",
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
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-start gap-4 px-6 pb-4 pt-6">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-lg font-semibold tracking-tight">{current.title}</DialogTitle>
              <DialogDescription className={cn("mt-1 text-sm text-muted-foreground", !current.blurb && "sr-only")}>
                {current.blurb ?? `${current.title} settings`}
              </DialogDescription>
            </div>
            <DialogClose className="-mr-2 -mt-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12 pt-2">{body}</div>
        </main>
      </DialogContent>
    </Dialog>
  );
}
