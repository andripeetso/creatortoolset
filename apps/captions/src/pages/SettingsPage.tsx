import { Fragment } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Cable, CalendarClock, Clapperboard, Cpu, Gauge, HardDrive, KeyRound, Laptop, ListChecks, Monitor, Palette, ShieldCheck, SlidersHorizontal, UserRound, Users, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AccountSection } from "@/components/settings/AccountSection";
import { AdminSection } from "@/components/settings/AdminSection";
import { WorkspaceSection } from "@/components/settings/WorkspaceSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { AutomationsSection } from "@/components/settings/AutomationsSection";
import { DevicesSection } from "@/components/settings/DevicesSection";
import { EditorSection } from "@/components/settings/EditorSection";
import { StorageSection } from "@/components/settings/StorageSection";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { ServiceKeysSection } from "@/components/settings/ServiceKeysSection";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { SetupSection } from "@/components/settings/SetupSection";
import { ThisMacSection, hasThisMac } from "@/components/settings/ThisMacSection";
import { UsageSection } from "@/components/settings/UsageSection";
import { useAuth, useMe } from "@/lib/auth";
import { settingsWithPlugins, visibleSettings, type SettingsEntry } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { cn } from "@/lib/utils";

const inDock = (t: EventTarget | null) => t instanceof Element && !!t.closest("[data-assistant-dock]");

/**
 * The sections, in the order the sidebar shows them. `group` starts a labelled block; the "Server" block (the server's
 * own API keys, admins only) is pinned to the bottom. `blurb` is the one line under the title: only what the title
 * doesn't say. This Mac is not here: the Mac app's Servers menu opens it.
 */
const BUILTIN_SECTIONS: ReadonlyArray<SettingsEntry> = [
  { id: "general", title: "General", blurb: "How the app behaves on this device.", icon: SlidersHorizontal },
  { id: "setup", title: "Setup", blurb: "Your AI, accounts, a first project and your knowledge, one step at a time.", icon: ListChecks },
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "account", title: "Account", blurb: "Your name, password and AI access key.", icon: UserRound },
  { id: "this-mac", title: "This Mac", blurb: "Your AI on this Mac, and the servers this app opens.", icon: Laptop, macOnly: true },
  { id: "providers", title: "Your AI", blurb: "The coding tools on your Macs that answer your AI.", icon: Cpu, group: "AI" },
  { id: "devices", title: "Devices", blurb: "The computers that run your AI.", icon: Monitor },
  { id: "editor", title: "Editor", blurb: "The design, grade, voice mix and sound effects every new edit starts with.", icon: Clapperboard },
  { id: "cache", title: "Cache", blurb: "What this computer keeps so screens open at once.", icon: HardDrive },
  { id: "usage", title: "Usage", blurb: "How much of each AI plan is left, and what the app used.", icon: Gauge },
  { id: "automations", title: "Automations", blurb: "Prompts the assistant runs on a schedule. Results go to your inbox.", icon: CalendarClock },
  { id: "connectors", title: "Connectors", blurb: "Your accounts, and the Apify key that reads the rest.", icon: Cable, group: "Data" },
  { id: "my-keys", title: "My API keys", blurb: "Your own keys for the paid services the tools call.", icon: KeyRound },
  { id: "keys", title: "API keys", blurb: "The server's own keys. They serve you, never your AI; other accounts use their own (My API keys).", icon: KeyRound, adminOnly: true, group: "Server" },
];

/** Hosted servers only (CT_MODE=hosted, from /api/auth/check): the team, and the platform admin's accounts and projects. */
const HOSTED_SECTIONS: ReadonlyArray<SettingsEntry> = [
  { id: "team", title: "Team", blurb: "Your team: invite links, members and the apps each one gets.", icon: Users, group: "Team" },
  { id: "admin", title: "Admin", blurb: "Accounts on this server, the apps each one gets, and every project.", icon: ShieldCheck, adminOnly: true, group: "Server" },
];

/** The sections this server shows; the hosted ones are added only on a hosted server. */
export const settingsSectionsFor = (hosted: boolean): SettingsEntry[] =>
  settingsWithPlugins(hosted ? [...BUILTIN_SECTIONS, ...HOSTED_SECTIONS] : BUILTIN_SECTIONS, webPlugins);

/**
 * Settings: a modal over the page you were on, `/settings/:section/:sub?`. App keeps the page behind it and `onClose`
 * goes back to it. The title row holds the close button, so nothing ever scrolls under it.
 */
export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const [, , section = "general", sub] = useLocation().pathname.split("/");
  const me = useMe();
  const hosted = useAuth((s) => s.hosted);
  // Packs moved to Community, a window of its own; old links land on what's installed
  if (section === "packs") return <Navigate to="/community/installed" replace />;
  // This Mac is the Mac app's own: a browser never lists it (ThisMacSection.tsx)
  const visible = visibleSettings(settingsSectionsFor(hosted), me).filter((s) => !s.macOnly || hasThisMac());
  const current = visible.find((s) => s.id === section);
  if (!current) return <Navigate to="/settings/general" replace />;

  const body = current.body ?? {
    general: <GeneralSection />,
    setup: <SetupSection />,
    appearance: <AppearanceSection />,
    "this-mac": <ThisMacSection />,
    providers: <ProvidersSection sub={sub} />,
    connectors: <ConnectorsSection />,
    "my-keys": <MyKeysSection />,
    usage: <UsageSection />,
    devices: <DevicesSection />,
    editor: <EditorSection />,
    cache: <StorageSection />,
    automations: <AutomationsSection />,
    account: <AccountSection />,
    keys: <ServiceKeysSection />,
    team: <WorkspaceSection />,
    admin: <AdminSection sub={sub} />,
  }[current.id];

  // Not modal, so the assistant's dock (above this, AssistantDock.tsx) can be clicked and typed in while Settings is
  // open; the backdrop is drawn here since a non-modal dialog has none. A click outside still closes Settings, but not
  // one in the dock, and focus moving out (to the dock, or a confirm opened from here) never does.
  return (
    <Dialog open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <div aria-hidden className="fixed inset-0 z-50 bg-black/50 motion-safe:animate-in motion-safe:fade-in-0" />
      </DialogPortal>
      <DialogContent
        showCloseButton={false}
        onFocusOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => inDock(e.target) && e.preventDefault()}
        onEscapeKeyDown={(e) => inDock(document.activeElement) && e.preventDefault()}
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
