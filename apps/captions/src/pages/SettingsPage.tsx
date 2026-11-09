import { Fragment, useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Cable, CalendarClock, Clapperboard, Cpu, Gauge, HardDrive, KeyRound, Monitor, Palette, Search, ShieldCheck, SlidersHorizontal, UserRound, Users, X } from "lucide-react";
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
import { KeyReadiness, SetupSection } from "@/components/settings/SetupSection";
import { ThisMacSection, hasThisMac } from "@/components/settings/ThisMacSection";
import { UsageSection } from "@/components/settings/UsageSection";
import { useAuth, useMe } from "@/lib/auth";
import { settingsWithPlugins, visibleSettings, type SettingsEntry } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { cn } from "@/lib/utils";

const inDock = (t: EventTarget | null) => t instanceof Element && !!t.closest("[data-assistant-dock]");

/**
 * The sections, in the order the sidebar shows them, in blocks: the top block has no heading, then
 * the labelled blocks (Agents, Connections), then the rest with no heading, and the server's block (admins only) is
 * pinned to the bottom. `blurb` is the one line under the title: only what the title doesn't say.
 * Retired ids (setup, this-mac, my-keys) redirect, see RETIRED_SECTIONS.
 */
const BUILTIN_SECTIONS: ReadonlyArray<SettingsEntry> = [
  { id: "general", title: "General", blurb: "How the app behaves on this device, and setup.", icon: SlidersHorizontal },
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "editor", title: "Editor", blurb: "The design, grade, voice mix and sound effects every new edit starts with.", icon: Clapperboard },
  { id: "account", title: "Account", blurb: "Your name, password and AI access key.", icon: UserRound },
  { id: "providers", title: "Providers", blurb: "The coding tools on your Macs that answer your AI.", icon: Cpu, group: "Agents" },
  { id: "devices", title: "Devices", blurb: "The computers that run your AI, and the servers this app opens.", icon: Monitor, group: "Agents" },
  { id: "automations", title: "Automations", blurb: "Prompts the assistant runs on a schedule. Results go to your inbox.", icon: CalendarClock, group: "Agents" },
  { id: "usage", title: "Usage", blurb: "How much of each AI plan is left, and what the app used.", icon: Gauge, group: "Agents" },
  { id: "connectors", title: "Connectors", blurb: "Your accounts, and the Apify key that reads the rest.", icon: Cable, group: "Connections" },
  { id: "keys", title: "API keys", blurb: "Your own keys for the paid services the tools call.", icon: KeyRound, group: "Connections" },
  // hosted servers only (HOSTED_ONLY): the team, and the platform admin's accounts and projects
  { id: "team", title: "Team", blurb: "Your team: invite links, members and the apps each one gets.", icon: Users, group: "Connections" },
  { id: "cache", title: "Cache", blurb: "What this computer keeps so screens open at once.", icon: HardDrive },
  { id: "admin", title: "Admin", blurb: "Accounts on this server, the apps each one gets, and every project.", icon: ShieldCheck, adminOnly: true, group: "Server" },
];

const HOSTED_ONLY = ["team", "admin"];

/** Old section ids and where they went. Links from the Mac app and older pages keep working. */
const RETIRED_SECTIONS: Readonly<Record<string, string>> = { setup: "general", "this-mac": "devices", "my-keys": "keys" };

/** The sections this server shows; the hosted ones are added only on a hosted server. */
export const settingsSectionsFor = (hosted: boolean): SettingsEntry[] =>
  settingsWithPlugins(
    BUILTIN_SECTIONS.filter((s) => hosted || !HOSTED_ONLY.includes(s.id)),
    webPlugins,
  );

/**
 * Settings: a modal over the page you were on, `/settings/:section/:sub?`. App keeps the page behind it and `onClose`
 * goes back to it. The title row holds the close button, so nothing ever scrolls under it.
 */
export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const [, , section = "general", sub] = useLocation().pathname.split("/");
  const me = useMe();
  const hosted = useAuth((s) => s.hosted);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // "/" jumps to the search field, unless a field already has the keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || t?.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Packs moved to Community, a window of its own; old links land on what's installed
  if (section === "packs") return <Navigate to="/community/installed" replace />;
  if (RETIRED_SECTIONS[section]) return <Navigate to={`/settings/${RETIRED_SECTIONS[section]}`} replace />;
  const visible = visibleSettings(settingsSectionsFor(hosted), me);
  const current = visible.find((s) => s.id === section);
  if (!current) return <Navigate to="/settings/general" replace />;
  const needle = query.trim().toLowerCase();
  const listed = needle ? visible.filter((s) => s.title.toLowerCase().includes(needle)) : visible;

  const body = current.body ?? {
    general: (
      <>
        <GeneralSection />
        <SetupSection />
      </>
    ),
    appearance: <AppearanceSection />,
    editor: <EditorSection />,
    account: <AccountSection />,
    providers: <ProvidersSection sub={sub} />,
    // This Mac is the Mac app's own: a browser never shows it (ThisMacSection.tsx)
    devices: (
      <>
        {hasThisMac() && <ThisMacSection />}
        <DevicesSection />
      </>
    ),
    automations: <AutomationsSection />,
    usage: <UsageSection />,
    connectors: <ConnectorsSection />,
    keys: (
      <>
        <MyKeysSection />
        <KeyReadiness />
        {me?.role === "admin" && <ServiceKeysSection />}
      </>
    ),
    team: <WorkspaceSection />,
    cache: <StorageSection />,
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
          <label className="relative mb-2 hidden shrink-0 md:block">
            <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
              placeholder="Search"
              aria-label="Search settings"
              className="h-8 w-full rounded-md bg-transparent pl-8 pr-7 text-sm outline-none placeholder:text-muted-foreground focus:bg-accent/60"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1 text-[11px] text-muted-foreground">/</kbd>
          </label>
          {listed.map((s, i) => {
            const Icon = s.icon;
            const on = s.id === current.id;
            const prev = listed[i - 1];
            const heading = s.group && s.group !== prev?.group;
            // a gap between blocks, so the heading-less top block and the others read apart
            const gap = i > 0 && (s.group ?? "") !== (prev?.group ?? "");
            return (
              <Fragment key={s.id}>
                {gap && <span aria-hidden className="hidden h-3 md:block" />}
                {heading && (
                  <span className="hidden px-2 pb-1 pt-4 text-[11px] font-medium text-muted-foreground md:block">
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
          <span aria-hidden className="mt-auto hidden shrink-0 pt-3 md:block">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase text-muted-foreground">
              {me?.username?.[0] ?? "?"}
            </span>
          </span>
        </nav>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-start gap-4 px-6 pb-4 pt-6">
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex items-center gap-2 text-sm font-normal">
                <span className="text-muted-foreground">Settings</span>
                <span className="text-muted-foreground/60">/</span>
                <span className="font-medium text-foreground">{current.title}</span>
              </DialogTitle>
              <DialogDescription className="sr-only">{current.blurb ?? `${current.title} settings`}</DialogDescription>
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
