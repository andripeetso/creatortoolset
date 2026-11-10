import { Bot, CalendarClock, Cpu, HardDrive, Gauge, KeyRound, Monitor, Palette, Server, ShieldCheck, Share2, SlidersHorizontal, UserRound, Users } from "lucide-react";
import { settingsWithPlugins, visibleSettings, type PluginSettingsSection, type SettingsEntry } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";

type PluginList = ReadonlyArray<{ settings?: PluginSettingsSection[] }>;

/**
 * The Settings pages: the one place that says which sections exist, which install and person sees each, and where old
 * ids go. The sidebar (SettingsPage), the account button and the search all read this.
 */

/** Every page id a Settings route can open. Adding one: add it here, to BUILTIN, and to PAGE_BODIES (pages.tsx). */
export const SETTINGS_PAGE_IDS = [
  "general", "appearance", "folders", "providers", "devices", "automations", "usage", "connectors", "keys", "own-ai",
  "servers", "team", "admin", "account",
] as const;
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];

/** What decides which sections show: the server (hosted or not), the person's role, and whether this is the Mac app. */
export interface NavContext {
  hosted: boolean;
  admin: boolean;
  mac: boolean;
}

interface BuiltinEntry extends SettingsEntry {
  id: SettingsPageId;
  /** Only on a hosted server (team and admin). */
  hostedOnly?: boolean;
  /** Only in the Mac app, where this computer's own settings are (servers). */
  macOnly?: boolean;
  /** False: routable but not in the sidebar (account: the account button is its entry). */
  listed?: false;
}

/** The built-in sections in sidebar order. Groups: none = top block; "AI", "Devices", "Connections", "People" are headed. */
const BUILTIN: ReadonlyArray<BuiltinEntry> = [
  { id: "general", title: "General", icon: SlidersHorizontal },
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "providers", title: "Providers", icon: Cpu, group: "AI" },
  { id: "automations", title: "Scheduled tasks", icon: CalendarClock, group: "AI" },
  { id: "usage", title: "Usage", icon: Gauge, group: "AI" },
  { id: "devices", title: "Computers", icon: Monitor, group: "Devices" },
  { id: "folders", title: "Storage", icon: HardDrive, group: "Devices" },
  { id: "servers", title: "Servers", icon: Server, group: "Devices", macOnly: true },
  { id: "connectors", title: "Social accounts", icon: Share2, group: "Connections" },
  { id: "keys", title: "API keys", icon: KeyRound, group: "Connections" },
  { id: "own-ai", title: "Your own AI", icon: Bot, group: "Connections" },
  { id: "team", title: "Team", icon: Users, group: "People", hostedOnly: true },
  { id: "admin", title: "Admin", icon: ShieldCheck, group: "People", hostedOnly: true, adminOnly: true },
  { id: "account", title: "Account", icon: UserRound, listed: false },
];

/** Old ids and where they go. A full path, so the editor's old id can leave Settings. */
export const RETIRED_PATHS: Readonly<Record<string, string>> = {
  setup: "/settings/general",
  cache: "/settings/general",
  "this-mac": "/settings/devices",
  "my-keys": "/settings/keys",
  editor: "/editor",
  packs: "/community/installed",
};

/** Every section this install and person may open (sidebar and account page), with the plug-ins' sections placed in. */
export function sectionsFor(ctx: NavContext, plugins: PluginList = webPlugins): SettingsEntry[] {
  const allowed = BUILTIN.filter((s) => (ctx.hosted || !s.hostedOnly) && (ctx.mac || !s.macOnly) && (ctx.admin || !s.adminOnly));
  return visibleSettings(settingsWithPlugins(allowed, plugins), { role: ctx.admin ? "admin" : "user" });
}

/** The sections the sidebar lists: sectionsFor without the routable-only ones (account). */
export function navListFor(ctx: NavContext, plugins: PluginList = webPlugins): SettingsEntry[] {
  return sectionsFor(ctx, plugins).filter((s) => !("listed" in s && s.listed === false));
}

/** Consecutive sidebar sections by group: the heading each block shows ("undefined" = the top block, no heading). */
export function navBlocks(list: ReadonlyArray<SettingsEntry>): Array<{ heading?: string; items: SettingsEntry[] }> {
  const blocks: Array<{ heading?: string; items: SettingsEntry[] }> = [];
  for (const s of list) {
    const last = blocks[blocks.length - 1];
    if (last && last.heading === s.group) last.items.push(s);
    else blocks.push({ heading: s.group, items: [s] });
  }
  return blocks;
}

/** Where a Settings path goes: a page to draw, or a redirect (old ids, a page this install does not show). */
export type SectionResolution = { kind: "page"; id: string } | { kind: "redirect"; to: string };

export function resolveSection(section: string, ctx: NavContext, plugins: PluginList = webPlugins): SectionResolution {
  if (RETIRED_PATHS[section]) return { kind: "redirect", to: RETIRED_PATHS[section] };
  if (sectionsFor(ctx, plugins).some((s) => s.id === section)) return { kind: "page", id: section };
  return { kind: "redirect", to: "/settings/general" };
}
