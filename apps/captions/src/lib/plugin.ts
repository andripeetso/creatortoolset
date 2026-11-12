import type { ComponentType, ReactNode } from "react";
import type { LibraryWebSlot } from "../../contracts/library-source";
import type { LucideIcon } from "lucide-react";
import type { PluginGateId } from "@contracts/tools";
import { canUse, type Me } from "./auth";
import type { ReviewAsset, ReviewVersion } from "./review";
import type { reviewApi } from "./review";
import type { Still } from "./grade-look";

// Browser half of a plug-in (plugins/<id>/web.tsx). Core code imports this file and never the generated
// registry (src/plugins.gen.ts), so the registry can import plug-ins without an import cycle.

/** A Home tile: a link to one of the plug-in's pages, in a Home stage (Plan, Make, Distribute) or the quiet Tools row. */
export interface PluginTile {
  stage: "Plan" | "Make" | "Distribute" | "Tools";
  to: string;
  phoneTo?: string;
  icon: LucideIcon;
  name: string;
  desc: string;
  // The access gate (the account's `off` list). A tile whose gate is switched off for the account is hidden.
  gate: PluginGateId;
}

/** One Settings section: built-in ones have no `body` (SettingsPage draws them); a plug-in's section brings its own. */
export interface SettingsEntry {
  id: string;
  title: string;
  icon: LucideIcon;
  /** The sidebar block it sits in ("AI", "Hardware", "Connections", "Plug-ins", "People"); none = the top block (a plug-in's: Plug-ins). */
  group?: string;
  adminOnly?: boolean;
  body?: ReactNode;
}

/**
 * A Settings section a plug-in adds. `group` places it inside that sidebar block (after the block's last section); with
 * no group it goes in the Plug-ins block (PLUGINS_GROUP).
 * `adminTab: true` shows it as a tab in Admin instead, after the built-in tabs (see adminTabsFor). `adminOnly` hides it
 * from everyone else.
 */
export interface PluginSettingsSection extends SettingsEntry {
  body: ReactNode;
  adminTab?: boolean;
}

/** A section a plug-in adds to Settings → Devices (`page: "computers"`, after its card) or → Storage (the default). `adminOnly` shows it to admins only. */
export interface PluginDevicesSection {
  id: string;
  title: string;
  adminOnly?: boolean;
  page?: "computers" | "storage";
  body: ReactNode;
}

/** An item in the account menu (top right). Shown to every signed-in account, or only where `gate` is on for it. */
export interface PluginAccountItem {
  label: string;
  to: string;
  icon: LucideIcon;
  gate?: PluginGateId;
}

/** Built-in pages a plug-in can swap for its own: `/editor` and `/editor/:id`. The built-in page renders when none does. */
export interface PluginReplacements {
  editor?: ComponentType;
  editorEdit?: ComponentType;
  // the Media Library (/library): a plug-in's catalog view replaces the storage library and its Home tile
  media?: ComponentType;
  // Finals (/finals): a plug-in's own Finals page (its list, pieces and actions) replaces the built-in one
  finals?: ComponentType;
  // Settings → Storage: a plug-in's own store and screen (the AI Editor's folders) replace the built-in folder rows
  storage?: ComponentType;
}

export type ReplaceSlot = keyof PluginReplacements;

/** The kinds of item a plug-in can put buttons on (a session in Content Workshop, a review upload, an export, a library item, the project open in Caption Studio). */
export type ItemKind = "export" | "review" | "session" | "library" | "captions";

/** A button a plug-in puts on an item. `onRun` gets the item's id. A gated one is left out while its gate is off for the account. */
export interface PluginItemAction {
  label: string;
  icon?: LucideIcon;
  gate?: PluginGateId;
  onRun: (id: string) => void | Promise<void>;
}

/** The player under the version on screen: its <video> element (null until it is mounted), seek and pause. */
export interface ReviewPlayerSlot {
  video: () => HTMLVideoElement | null;
  seek: (seconds: number) => void;
  pause: () => void;
}

/** The comment box. `setPending` shows chips for edits not sent yet (an empty list clears them); `setPayload` attaches
 *  data to the next comment under this plug-in's id (JSON, at most 64 KB; null clears it). `onSent` runs once the
 *  comment carrying them is posted, so the plug-in can drop what it sent. */
export interface ReviewComposerSlot {
  setPending: (labels: string[]) => void;
  setPayload: (data: unknown | null) => void;
  /** Refuses a send with no written text while this plug-in holds data that needs words (null lifts it). */
  setNeedsText: (why: string | null) => void;
  onSent: (fn: () => void) => () => void;
  /** The comment box's text as it is typed (called now with the current text, then on each change). */
  onText: (fn: (text: string) => void) => () => void;
}

/** ⌘Z / ⇧⌘Z for this plug-in's own edits. The newest registration gets the keys; the plug-in no-ops when it has nothing. */
export interface ReviewHistorySlot {
  register: (handlers: { undo: () => void; redo: () => void }) => () => void;
}

/**
 * How the player should play the version while a plug-in's preview is on: spans of the video (in its frames, at `fps`)
 * that the player follows. A skip is jumped over; a hold pauses on frame `at` for `frames` frames; a mute plays silent;
 * a frame zooms the picture to `box` (k = zoom, x and y = offset as a fraction of the picture). `cards` are the planned
 * edits' cards over the picture (see ReviewPlayCard). The player follows the merged plans of all plug-ins (lib/review-play.ts).
 */
export interface ReviewPlayPlan {
  fps: number;
  skips: [number, number][];
  mutes: [number, number][];
  holds: { at: number; frames: number }[];
  cards: ReviewPlayCard[];
  frames: { from: number; to: number; box: { x: number; y: number; k: number } }[];
  /** A look the picture takes over a span: a CSS `filter` value (e.g. `url(#id)` of an SVG filter the panel draws). */
  looks?: { from: number; to: number; filter: string }[];
}

/**
 * One planned card, in frames: a B-roll shot, a graphic or a placeholder (`track` V… = video, A… = audio; `kind` gone =
 * a card whose shot is no longer in the cut). The page draws the top video card over the picture and the rest as chips.
 * `src` (optional) is a clip that plays in the card's place, from `at` seconds; the plug-in sets it only for people
 * allowed to see the clip.
 */
export interface ReviewPlayCard {
  from: number;
  to: number;
  track: string;
  label: string;
  kind: "added" | "gone" | "hole";
  look?: "card" | "solid" | "outline";
  color?: string;
  src?: string;
  at?: number;
}

/** `setPlan(plan)` shows the plan on this version's player; `null` clears it (a plug-in clears it when it unmounts). */
export interface ReviewPreviewSlot {
  setPlan: (plan: ReviewPlayPlan | null) => void;
}

/** What a Review slot gets for the version on screen. `manage` is true for managers (the people who edit it). */
export interface ReviewSlotContext {
  asset: ReviewAsset;
  version: ReviewVersion;
  manage: boolean;
  api: ReturnType<typeof reviewApi>;
  reload: () => Promise<void>;
  player: ReviewPlayerSlot;
  composer: ReviewComposerSlot;
  history: ReviewHistorySlot;
  /** The play plan the player follows while this plug-in's preview is on (see ReviewPlayPlan). */
  preview: ReviewPreviewSlot;
  /** This plug-in's data on the open comments of this version, oldest first: what they already sent. */
  sent: ReviewSentEntry[];
}

/** One open comment's data under a plug-in id: the comment's id and the data it carried. */
export interface ReviewSentEntry {
  id: string;
  data: unknown;
}

/** A panel a plug-in puts under the Review header, for each version. Shown to managers only, and only where `gate` is on. */
export interface ReviewPanelSlot {
  id: string;
  gate?: PluginGateId;
  panel: ComponentType<ReviewSlotContext>;
}

/** A toolbar button a plug-in puts in the Review header. Shown to managers only, and only where `gate` is on. */
export interface ReviewActionSlot {
  label: string;
  icon?: LucideIcon;
  gate?: PluginGateId;
  onRun: (ctx: ReviewSlotContext) => void | Promise<void>;
}

/** The AI edit a Review version previews (ReviewVersion.edit). */
export type ReviewEditRef = { project: string; draft: string };

/**
 * What a plug-in adds to Review's timeline editor (components/ReviewEdits.tsx), which every install has on a version
 * with a timeline. All optional; the first plug-in that gives one is used.
 * - `clipSrc`: a planned card's clip (TimelineItem.clip) plays in the card from this URL.
 * - `camera`: on an AI edit, the whole camera frame shown under Reframe (a video URL), once it is there; Reframe is
 *   offered only where this is set. Rejects with a message the panel shows.
 * - `look`: on an AI edit, the Color panel's full-quality frame and clip of a shot (frame `at`).
 */
export interface ReviewTimelineSlot {
  clipSrc?: (clip: number) => string;
  camera?: (edit: ReviewEditRef, signal: AbortSignal) => Promise<string>;
  look?: {
    still: (edit: ReviewEditRef, key: string, at: number, signal?: AbortSignal) => Promise<Still>;
    clip: (edit: ReviewEditRef, key: string, at: number, signal?: AbortSignal) => Promise<string>;
  };
}

/**
 * A product site a plug-in serves on its own hosts, signed in or not, in place of the app (the hosted front page, its
 * download and legal pages). `claims` says which pages the site takes; any other page is the app as usual.
 */
export interface SiteFrame {
  hosts: string[];
  claims: (pathname: string, search: string) => boolean;
  element: ReactNode;
}

export interface WebPlugin {
  id: string;
  // The name the Community → Plug-ins list shows (the id when absent) and one short line on what it does.
  name?: string;
  about?: string;
  // A product site on its own host(s), see SiteFrame. AuthGate shows it before the sign-in form.
  site?: SiteFrame;
  // Pages added to the app's Routes. Paths must not repeat a built-in page; the generator checks that.
  routes?: { path: string; element: ReactNode }[];
  // Media Library sidebar facets and item badges (LibraryPage reads them from webPlugins).
  library?: LibraryWebSlot;
  tiles?: PluginTile[];
  settings?: PluginSettingsSection[];
  devices?: PluginDevicesSection[];
  accountMenu?: PluginAccountItem[];
  replaces?: PluginReplacements;
  itemActions?: Partial<Record<ItemKind, PluginItemAction[]>>;
  // Review: panels under the header and toolbar buttons, for the version on screen (ReviewAssetPage).
  review?: { panels?: ReviewPanelSlot[]; actions?: ReviewActionSlot[]; timeline?: ReviewTimelineSlot };
}

export const defineWebPlugin = (plugin: WebPlugin): WebPlugin => plugin;

/** A Review slot entry with a React key unique across plug-ins: `<plug-in id>/<slot id or label>`. */
export type ReviewPanelEntry = ReviewPanelSlot & { key: string; pluginId: string };
export type ReviewActionEntry = ReviewActionSlot & { key: string; pluginId: string };

/** The timeline editor's plug-in parts: each one from the first plug-in that gives it (see ReviewTimelineSlot). */
export function reviewTimelineOf(plugins: WebPlugin[]): ReviewTimelineSlot {
  const pick = <K extends keyof ReviewTimelineSlot>(k: K) => plugins.find((p) => p.review?.timeline?.[k])?.review?.timeline?.[k];
  return { clipSrc: pick("clipSrc"), camera: pick("camera"), look: pick("look") };
}

/** The Review panels and toolbar buttons this account may see: a gated one is left out while its gate is off (canUse). */
export function reviewSlotsFor(me: Me | null, plugins: WebPlugin[]): { panels: ReviewPanelEntry[]; actions: ReviewActionEntry[] } {
  const ok = <T extends { gate?: PluginGateId }>(x: T) => !x.gate || canUse(me, x.gate);
  return {
    panels: plugins
      .flatMap((p) => (p.review?.panels ?? []).map((s) => ({ ...s, key: `${p.id}/${s.id}`, pluginId: p.id })))
      .filter(ok),
    actions: plugins
      .flatMap((p) => (p.review?.actions ?? []).map((a) => ({ ...a, key: `${p.id}/${a.label}`, pluginId: p.id })))
      .filter(ok),
  };
}

/**
 * The component a plug-in puts in place of a built-in page, or undefined when none does (the built-in page renders).
 * Two plug-ins replacing the same page is an error: throws.
 */
export function replacementFor(plugins: WebPlugin[], slot: ReplaceSlot): ComponentType | undefined {
  const hits = plugins.filter((p) => p.replaces?.[slot]);
  if (hits.length > 1) throw new Error(`more than one plug-in replaces the ${slot} page: ${hits.map((p) => p.id).join(", ")}`);
  return hits[0]?.replaces?.[slot];
}

/** The item buttons of one kind this account may use: a gated one is left out while its gate is off (canUse, so admins see it). */
export function itemActionsFor(me: Me | null, plugins: WebPlugin[], kind: ItemKind): PluginItemAction[] {
  return plugins.flatMap((p) => p.itemActions?.[kind] ?? []).filter((a) => !a.gate || canUse(me, a.gate));
}

/**
 * The built-in Settings sections with each plug-in's sidebar sections placed in them: a section with a `group` goes after
 * the last section of that group; one without goes at the end of the top block (before the first headed group). Admin
 * tabs (adminTab) are not sidebar sections and are left out (see adminTabsFor). A plug-in section may not reuse a
 * built-in id (it would hide that section): throws.
 */
/** The sidebar block for a plug-in's section with no group, beside the AI Editor's steps: after Connections, before
 *  People (owner, 2026-11-11: "a setting submenu for like plug-ins… this should be all grouped up"). */
export const PLUGINS_GROUP = "Plug-ins";

export function settingsWithPlugins<T extends SettingsEntry>(
  builtin: ReadonlyArray<T>,
  plugins: ReadonlyArray<{ settings?: PluginSettingsSection[] }>,
): Array<T | PluginSettingsSection> {
  const extra = plugins.flatMap((p) => p.settings ?? []).filter((s) => !s.adminTab);
  for (const s of extra) {
    if (builtin.some((b) => b.id === s.id)) throw new Error(`plug-in settings section "${s.id}" is already a built-in section`);
  }
  const out: Array<T | PluginSettingsSection> = [...builtin];
  for (const section of extra) {
    const s = section.group ? section : { ...section, group: PLUGINS_GROUP };
    const last = out.map((x) => x.group).lastIndexOf(s.group);
    const people = out.findIndex((x) => x.group === "People");
    out.splice(last >= 0 ? last + 1 : s.group === PLUGINS_GROUP && people >= 0 ? people : out.length, 0, s);
  }
  return out;
}

/** The Admin tabs the plug-ins add (adminTab), in plug-in order, for this account: admins only. Admin shows them after its own. */
export const adminTabsFor = (me: { role: string } | null, plugins: WebPlugin[]): PluginSettingsSection[] =>
  plugins.flatMap((p) => p.settings ?? []).filter((s) => s.adminTab && me?.role === "admin");

/** The site frame a plug-in claims for this address, or null (the app). */
export function siteFrameFor(hostname: string, pathname: string, search: string, plugins: WebPlugin[]): { element: ReactNode } | null {
  for (const p of plugins) {
    const s = p.site;
    if (s && s.hosts.includes(hostname) && s.claims(pathname, search)) return { element: s.element };
  }
  return null;
}

/** One line of "what a plug-in adds": its text, and the path it lives at when this person can open that path. */
export interface PluginAdd {
  text: string;
  to?: string;
}

/** A loaded plug-in as Community lists it: name, about, and what it adds (web and server parts merged). */
export interface PluginInfo {
  id: string;
  name: string;
  about?: string;
  adds: PluginAdd[];
}

/** A server plug-in as GET /api/plugins returns it (api/lib/plugin.ts describeServerPlugins). `adds` is for admins only. */
export interface ServerPluginInfo {
  id: string;
  name: string;
  about?: string;
  adds?: PluginAdd[];
}

const linkable = (to: string) => (/[:*]/.test(to) ? undefined : to);

/**
 * What a web plug-in adds, one line per place, each linked to where it lives. Only what this person can open: admin tabs
 * need the hosted server and an admin; a gated tile or menu item is left out while its gate is off for the account.
 */
export function webPluginAdds(p: WebPlugin, ctx: { me: Me | null; hosted: boolean }): PluginAdd[] {
  const admin = ctx.me?.role === "admin";
  const out: PluginAdd[] = [];
  for (const t of p.tiles ?? []) if (canUse(ctx.me, t.gate)) out.push({ text: `Home: ${t.name}`, to: linkable(t.to) });
  for (const s of p.settings ?? []) {
    if (s.adminOnly && !admin) continue;
    if (s.adminTab) {
      if (admin && ctx.hosted) out.push({ text: `Settings → Admin → ${s.title}`, to: `/settings/admin/${s.id}` });
    } else out.push({ text: s.group ? `Settings → ${s.group}: ${s.title}` : `Settings: ${s.title}`, to: `/settings/${s.id}` });
  }
  for (const d of p.devices ?? []) if (!d.adminOnly || admin) {
    const computers = d.page === "computers";
    out.push({ text: `Settings → ${computers ? "Devices" : "Storage"}: ${d.title}`, to: computers ? "/settings/devices" : "/settings/folders" });
  }
  const r = p.replaces ?? {};
  if (r.editor || r.editorEdit) out.push({ text: "Replaces the AI Editor page", to: "/editor" });
  if (r.media) out.push({ text: "Replaces the Media Library page", to: "/library" });
  if (r.finals) out.push({ text: "Replaces the Finals page", to: "/finals" });
  if (r.storage) out.push({ text: "Replaces Settings → Storage", to: "/settings/folders" });
  // its own pages: only ones a person can open by themselves (an address with a :part needs something picked first),
  // and not the page a Home tile or a replaced page already named above
  for (const route of p.routes ?? []) {
    const to = linkable(route.path);
    if (!to || route.path.includes(":") || out.some((o) => o.to === to)) continue;
    out.push({ text: `Its own page: ${route.path}`, to });
  }
  for (const a of p.accountMenu ?? []) if (!a.gate || canUse(ctx.me, a.gate)) out.push({ text: `Account menu: ${a.label}`, to: linkable(a.to) });
  const places: Record<ItemKind, [string, string | undefined]> = {
    export: ["exports", undefined],
    review: ["Review versions", "/review"],
    session: ["Workshop pieces", "/workshop"],
    library: ["Media Library items", "/library"],
    captions: ["Caption Studio projects", "/captions"],
  };
  for (const [kind, actions] of Object.entries(p.itemActions ?? {}) as [ItemKind, PluginItemAction[]][]) {
    const [noun, to] = places[kind];
    for (const a of actions) if (!a.gate || canUse(ctx.me, a.gate)) out.push({ text: `Button on ${noun}: ${a.label}`, to });
  }
  for (const s of p.review?.panels ?? []) if (!s.gate || canUse(ctx.me, s.gate)) out.push({ text: "A panel in Review", to: "/review" });
  for (const a of p.review?.actions ?? []) if (!a.gate || canUse(ctx.me, a.gate)) out.push({ text: `Review button: ${a.label}`, to: "/review" });
  if (p.library) out.push({ text: "Media Library filters", to: "/library" });
  if (p.site) out.push({ text: `Front page on ${p.site.hosts.join(", ")}` });
  return out;
}

/**
 * The plug-ins Community lists: every web plug-in and every server plug-in, merged by id (web first, then server-only ones).
 * A name and about come from the web definition, then the server's. The adds are both halves, without repeats.
 */
export function mergePluginInfo(web: WebPlugin[], server: ServerPluginInfo[], ctx: { me: Me | null; hosted: boolean }): PluginInfo[] {
  const byId = new Map<string, PluginInfo>();
  for (const p of web) byId.set(p.id, { id: p.id, name: p.name ?? p.id, about: p.about, adds: webPluginAdds(p, ctx) });
  for (const s of server) {
    const have = byId.get(s.id);
    if (!have) {
      byId.set(s.id, { id: s.id, name: s.name, about: s.about, adds: s.adds ?? [] });
      continue;
    }
    have.about ??= s.about;
    for (const a of s.adds ?? []) if (!have.adds.some((x) => x.text === a.text)) have.adds.push(a);
  }
  return [...byId.values()];
}

/** The Settings sections this account sees: an adminOnly one (built-in or a plug-in's) only for an admin. */
export const visibleSettings = (sections: ReadonlyArray<SettingsEntry>, me: { role: string } | null): SettingsEntry[] =>
  sections.filter((s) => !s.adminOnly || me?.role === "admin");

/** The Devices or Storage sections the plug-ins add for this account (`page`, default storage): an adminOnly one only for an admin. */
export const devicesSectionsFor = (me: { role: string } | null, plugins: WebPlugin[], page: "computers" | "storage" = "storage"): PluginDevicesSection[] =>
  plugins.flatMap((p) => p.devices ?? []).filter((s) => (s.page ?? "storage") === page && (!s.adminOnly || me?.role === "admin"));

/**
 * The plug-ins' account menu items this account may use: an item with a gate is left out while that gate is off for
 * the account (canUse, so admins always see it).
 */
export function accountItemsFor(me: Me | null, plugins: WebPlugin[]): PluginAccountItem[] {
  return plugins.flatMap((p) => p.accountMenu ?? []).filter((item) => !item.gate || canUse(me, item.gate));
}
