import { Hono as HonoApp, type Hono, type MiddlewareHandler } from "hono";
import { applyNeedWays, isPluginGateId, isTool, TOOL_NAMES, type Have, type NeedWay, type PluginGateId, type Tool } from "../../contracts/tools";
import type { LibrarySlot } from "../../contracts/library-source";
import type { EditFlag, FootageTarget, Timeline } from "../../contracts/editor";
import type { StepInfo } from "../../contracts/editor-steps";
import { DRIVERS, type DriverKind, type ProviderPreset } from "../../contracts/providers";
import { checkLibrarySlots, registerLibrarySlot } from "../library/sources";
import type { ActivityFn, MenuFn } from "../activity";
import type { FinalsAdd, FinalsOutcome, FinalsSource } from "../library/finals";
import { readers, registerPublicGridReader, registerReader, type PublicGridReader, type SocialReader } from "./connectors/provider";
import type { UploadRelayTus } from "../../contracts/storage";
import type { SessionUser } from "../users";
import { PACK_ITEM_KINDS, PACK_LIMITS, PACK_SLOTS, checkPackSkill, skillNameKey, type PackDesignSystem, type PackItemKind, type PackOrigin, type PackSkill } from "../../contracts/packs";

// The plug-in slot. A plug-in is a folder plugins/<id>/ that scripts/plugins.mjs finds at build time:
// plugin.ts is its server entry (definePlugin), web.tsx its browser entry (defineWebPlugin, src/lib/plugin.ts).
// Core code imports this file and never the generated registries, so the registries can import plug-ins
// without an import cycle.

export interface ServerPlugin {
  id: string;
  // The name Community lists it under (the id when absent) and one short line on what it does.
  name?: string;
  about?: string;
  // What it is, in a few words ("AI Editor step"), on a plug-in the team bundles with the app (editor-steps/<folder>):
  // Community → Plug-ins shows it on the row. Read as text from plugin.ts like name and about, so write it right after them.
  kind?: string;
  // Environment variable names this plug-in reads. The generator warns about any that are not set.
  env?: string[];
  // Mounted at /api/x/<id>, behind the same login as every other /api route.
  routes?: Hono<any, any, any>;
  // Mounted at the root before the account gate (boot.ts), for callers that hold no account login: a machine caller
  // with its own token, for example. The routes must give their own answer (a bearer token, say). Full paths.
  openRoutes?: Hono<any, any, any>;
  // Mounted at /api/admin in hosted mode only, ahead of the built-in admin routes (boot.ts), so a plug-in answers an admin path
  // under its old URL. Paths are relative to /api/admin. The routes must refuse a non-admin themselves (403).
  adminRoutes?: Hono<any, any, any>;
  // Mounted at /api/library after the account gate and ahead of the Media Library's own routes, so a plug-in can answer
  // a path the Media Library also uses (its own answer, or next() to hand the request on). Full paths.
  libraryRoutes?: Hono<any, any, any>;
  // Access gates. `ids` are checked by requireGate(id) on the plug-in's own routes; `defaultOff` are switched off
  // for every new role-"user" account (api/users.ts createUser) and each team invite. A default-off entry may also be
  // a built-in app id (the Media Library is "media"). A gate in an account's `off` list hides its tile
  // and refuses its routes. Admins are never refused.
  gates?: { ids: PluginGateId[]; defaultOff?: (PluginGateId | Tool)[] };
  // Media Library sources, policies (second gates) and sidebar facets, registered at mount (api/library/sources.ts).
  library?: LibrarySlot;
  // Rows for the Mac menu bar panel, read by GET /api/activity (api/activity.ts).
  activity?: ActivityFn;
  // LaunchAgent labels this plug-in's rows may start, stop or restart on the Mac the app runs on (a row's buttons, ActivityAction).
  // A row's button for any other label is dropped by the server before it reaches the Mac (activity.ts cleanActions).
  launchAgents?: string[];
  // Items for the Mac app's Go and gear menus, read by GET /api/activity/menu (api/activity.ts).
  menu?: MenuFn;
  // Per-edit flags: each shows as a chip on an AI Editor edit and is saved with that edit (api/editor/store.ts).
  editFlags?: EditFlag[];
  // Send to Finals (api/library/finals.ts): a guard asked before each piece is made. A string refuses it, with the reason
  // shown to the user; a guard that throws refuses too. Absent = allowed.
  // onAdded runs after a piece is added (its outcome says what was linked or stored); a throw is logged and skipped.
  finals?: {
    beforeAdd?: (input: FinalsAdd) => string | null | Promise<string | null>;
    onAdded?: (input: FinalsAdd, source: FinalsSource, outcome: FinalsOutcome) => unknown;
  };
  // editor.ingest: where footage an account adds to an AI Editor edit from its computer is filed (api/editor/ingest.ts).
  // The first plug-in that answers wins; null or absent = the account's own library's A-roll folder. A throw refuses (fails closed).
  // editor.steps: post-processing steps of the AI Editor (contracts/editor-steps.ts), run in `order` after the B-roll and
  // before the preview (api/editor/post.ts); Settings → AI Editor lists them for each account to use or not.
  editor?: { footageTarget?: (username: string) => FootageTarget | null | Promise<FootageTarget | null>; steps?: EditorStep[] };
  // Workshop "check now" for a post he pasted or shared (PATCH /sessions/:id with posted): reads it and matches it to a version.
  // The session's own write stays in core; the first plug-in that answers wins. `account` is the project's Instagram account.
  workshop?: {
    checkPosted?: (user: SessionUser, session: { id: string }, account: string | null | undefined, posted: PostedCheckInput) => Promise<PostedCheckResult | null>;
    // Finals versions a session's piece has that the library does not keep (a plug-in's own Finals link). The picker, the chat's
    // "which version" context and the post-description tabs read them after the library's (finalsLinkedTo in api/library/finals.ts).
    finalsVersions?: (sessionId: string, docId: string, mainDocId: string | undefined) => Promise<FinalsVersion[]>;
  };
  // Lets the install's own Meta login (META_ACCESS_TOKEN + INSTAGRAM_USER_ID) read Instagram on a public install
  // that is not hosted. Read by graph.ts (installLoginAllowed). Off by default.
  installMetaLogin?: boolean;
  // Routes mounted before the account gate, so they answer signed out (a public site, release downloads and feeds, a
  // sign-in service). Each route checks its own access; the gate never runs for them. `path` is an absolute path.
  publicRoutes?: { path: string; app: Hono<any, any, any> }[];
  // Routes mounted after the account gate at their own path (not under /api/x/<id>), for an existing URL that must keep
  // its gate, e.g. a release upload the signed-in admin makes.
  gatedRoutes?: { path: string; app: Hono<any, any, any> }[];
  // Runs once when the server starts (not under tests): a background job of the plug-in, e.g. a daily ping.
  start?: () => void;
  // Lets a route take a body past the 50 MB cap (an installer upload, e.g. a release), for the requests it returns true for.
  bodyLimitExempt?: (method: string, path: string) => boolean;
  // AI providers (Settings → Providers, Add provider): driver kinds the grid lists, and ready presets shown as rows with a badge.
  providers?: { kinds?: DriverKind[]; presets?: ProviderPreset[] };
  // The anonymous public-grid read (connectors/provider.ts). Without a plug-in that sets it, the app has no such read.
  connectors?: { publicGrid?: PublicGridReader; readers?: SocialReader[] };
  // Upload relays for Review's big videos (api/review.ts): the server uses one when CT_UPLOAD_RELAY names it and it is available.
  uploadRelays?: UploadRelay[];
  // Replaces a built-in tool: answers that tool's old root paths (the URLs a script or worker still posts to), mounted by
  // boot.ts ahead of the built-in router, so the plug-in answers first. `paths` must be in REPLACEABLE_PATHS, and no two
  // plug-ins may claim one. `largeBodies` are the request paths that may carry a body over 50 MB (read after the token check).
  replaces?: { paths: string[]; routes: Hono<any, any, any>; largeBodies?: RegExp[] };
  // Answers a built-in root path before that path's own router, so the plug-in takes a path the built-in router also serves (an
  // old GET /:id, say). Routes are relative to the path ("/session" under "/api/instagram"). Mounted by boot.ts before the built-in
  // router. `path` must be in ANSWERABLE_PATHS, and no two plug-ins may answer the same path.
  answers?: { path: string; routes: Hono<any, any, any> }[];
  // MCP tools (api/mcp.ts pluginToolsOf): { defs, handlers, replaces }. replaces lists the built-in tool names this plug-in answers instead.
  tools?: unknown;
  // Installers for pack items the core can't install itself (a design system for the AI Editor). Each kind is installed by
  // at most one plug-in; a pack's items of a kind with no installer are held on the account (api/lib/packs.ts).
  packItems?: PackItemInstaller[];
  // Another way to meet a tool's required row on Home, in setup and in Settings → Tools ("Needs an API key or an Adobe
  // sign-in"): `what` names it, `met` says whether this account has it. Read by api/setup.ts (pluginNeeds).
  needs?: PluginNeed[];
  // Skills for the places a pack's skills may go (contracts/packs.ts PACK_SKILL_SLOTS, never the assistant): text the
  // job reads, checked like a pack's when the server starts (one that fails is left out and named in the log). Each
  // account switches them on in Community → Skills (api/lib/skills.ts); an AI Editor script skill is picked on a style.
  skills?: PackSkill[];
  // Reserved for later waves. Nothing reads these yet; the generator warns when a plug-in sets one.
  on?: unknown;
}

export const definePlugin = (plugin: ServerPlugin): ServerPlugin => plugin;

/**
 * Puts one kind of pack item in place for an account. `install` returns the name it landed under. `remove` takes the
 * item out again only while it is still the pack's own copy (false = the person built on it, so it stays). `adminOnly`:
 * only an admin's install runs it (a pack from the community catalog never installs these for anyone else).
 */
export interface PackItemInstaller {
  kind: PackItemKind;
  adminOnly?: boolean;
  install: (item: PackDesignSystem, origin: PackOrigin) => Promise<string>;
  remove: (name: string, pack: string) => Promise<boolean>;
}

/** A plug-in's way to meet a tool's required row (ServerPlugin.needs). A `met` that throws counts as not met. */
export interface PluginNeed {
  tool: Tool;
  what: string;
  met: (user: SessionUser) => boolean | Promise<boolean>;
  /** The id of the plug-in's own Settings section (web.tsx `settings`) where the person sets it up. */
  settings?: string;
}

const wayOf = (p: ServerPlugin, n: PluginNeed): NeedWay => ({ tool: n.tool, what: n.what, have: `plugin:${p.id}/${n.tool}`, ...(n.settings ? { settings: n.settings } : {}) });

/** The loaded plug-ins' ways, and the ones this account has (for its setup view, api/setup.ts). */
export async function pluginNeeds(user: SessionUser): Promise<{ ways: NeedWay[]; have: Have[] }> {
  const ways: NeedWay[] = [];
  const have: Have[] = [];
  for (const p of loaded) {
    for (const n of p.needs ?? []) {
      const way = wayOf(p, n);
      ways.push(way);
      try {
        if ((await n.met(user)) === true) have.push(way.have);
      } catch (e) {
        console.warn(`[plugin] ${p.id} setup check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { ways, have };
}

/** Refuses a need whose tool is not a tool, with no `what`, or whose `met` is not a function. */
function checkNeeds(plugins: ServerPlugin[]): void {
  for (const plugin of plugins) {
    if (plugin.needs === undefined) continue;
    if (!Array.isArray(plugin.needs)) throw new Error(`plug-in ${plugin.id}: needs must be a list`);
    for (const n of plugin.needs) {
      if (!isTool(n?.tool)) throw new Error(`plug-in ${plugin.id}: needs: "${String(n?.tool)}" is not a tool`);
      if (typeof n.what !== "string" || !n.what.trim()) throw new Error(`plug-in ${plugin.id}: needs: each one needs a what`);
      if (typeof n.met !== "function") throw new Error(`plug-in ${plugin.id}: needs: met must be a function`);
      if (n.settings !== undefined && typeof n.settings !== "string") throw new Error(`plug-in ${plugin.id}: needs: settings is a Settings section's id`);
    }
  }
}

/** One line of what a plug-in adds, as the Community window lists it: text, and a path to where it lives (when there is one). */
export interface PluginAdd {
  text: string;
  to?: string;
}

/** A loaded plug-in as GET /api/plugins returns it. `adds` is only sent to an admin. Names only: no secrets, paths or endpoints. */
export interface PluginDescription {
  id: string;
  name: string;
  about?: string;
  adds?: PluginAdd[];
}

/**
 * What each loaded plug-in registers, in words: an AI provider preset by its name, a connector by its label, the tools
 * for the person's own AI by count, and so on. The web half of a plug-in (its Settings sections, pages) is in src/lib/plugin.ts.
 */
export function describeServerPlugins(plugins: ServerPlugin[], admin: boolean): PluginDescription[] {
  return plugins.map((p) => {
    const d: PluginDescription = { id: p.id, name: p.name ?? p.id, about: p.about };
    if (!admin) return d;
    const adds: PluginAdd[] = [];
    for (const k of p.providers?.kinds ?? []) adds.push({ text: `AI provider kind: ${k.label}`, to: "/settings/providers" });
    for (const pr of p.providers?.presets ?? []) adds.push({ text: `AI provider preset: ${pr.name}`, to: "/settings/providers" });
    for (const r of p.connectors?.readers ?? []) adds.push({ text: `Connector: ${r.session?.label ?? "social reader"}`, to: "/settings/connectors" });
    for (const r of p.uploadRelays ?? []) adds.push({ text: `Upload relay: ${r.label}` });
    const tools = (p.tools as { defs?: unknown[] } | undefined)?.defs?.length ?? 0;
    if (tools) adds.push({ text: `${tools} ${tools === 1 ? "tool" : "tools"} for your own AI`, to: "/settings/own-ai" });
    for (const f of p.editFlags ?? []) adds.push({ text: `AI Editor flag: ${f.label}`, to: "/editor" });
    for (const st of p.editor?.steps ?? []) adds.push({ text: `AI Editor step: ${st.title}`, to: "/settings/editor" });
    for (const i of p.packItems ?? []) adds.push({ text: `Pack items: ${i.kind === "designSystems" ? "design systems" : i.kind}` });
    if (p.library) adds.push({ text: "Media Library source", to: "/library" });
    if (p.finals) adds.push({ text: "Finals hook", to: "/finals" });
    if (p.activity) adds.push({ text: "Rows in the Mac menu bar panel" });
    for (const n of p.needs ?? []) adds.push({ text: `${TOOL_NAMES[n.tool]} setup: ${n.what.charAt(0).toLowerCase()}${n.what.slice(1)}`, to: "/settings/tools" });
    for (const k of checkedSkills(p)) adds.push({ text: `Skill for ${PACK_SLOTS[k.slot]}: ${k.name}`, to: "/community/skills" });
    d.adds = adds;
    return d;
  });
}

/**
 * A post-processing step. `run` gets the files a draft plays now (by source version id; an earlier step's copies where
 * it made one) and returns the copies it made, by the same ids: the same length, frame rate and timecode as the file it
 * replaces, so every cut stays where it is. Files go in `workDir` (the edit's own folder). A source it leaves alone is
 * not in the answer. A throw fails the edit's post step with its message.
 */
export interface EditorStep extends StepInfo {
  run(input: EditorStepInput): Promise<Record<string, string>>;
}

export interface EditorStepInput {
  edit: { id: string; name: string; createdBy: string };
  /** the version of the edit this draft is ("" when there is one) */
  variant: string;
  files: Record<string, string>;
  /** the draft: which source plays where (V1 the speaker, V2 B-roll, A1 the voice) */
  timeline: Timeline;
  /** the person's values for the step's options, with the defaults filled in */
  values: Record<string, string>;
  workDir: string;
  signal: AbortSignal;
  /** a line for the draft's notes, a whole sentence ("Blur faces found no face that matches …"): shown with the edit */
  note(text: string): void;
  /** one line on the edit page while it runs: what it is doing now (a first-time install, waiting for the person's AI) */
  say(text: string): void;
}

/** The ids of the loaded plug-ins (compiled in and from the plug-ins folder). */
export const loadedPluginIds = (): string[] => loaded.map((p) => p.id);

/** Every loaded plug-in's editor steps, lowest `order` first, each with the id of the plug-in it comes from. */
export function pluginEditorSteps(): (EditorStep & { pluginId: string })[] {
  return loaded
    .flatMap((p) => (p.editor?.steps ?? []).map((s) => ({ ...s, pluginId: p.id })))
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

/** The loaded plug-in that installs a pack item kind, or null (the core then holds those items on the account). */
export function packItemInstaller(kind: PackItemKind): PackItemInstaller | null {
  for (const p of loaded) for (const i of p.packItems ?? []) if (i.kind === kind) return i;
  return null;
}

/** Refuses an installer for a kind the core doesn't know, or a kind two plug-ins both install. */
function checkPackItems(plugins: ServerPlugin[]): void {
  const owner = new Map<string, string>();
  for (const plugin of plugins) {
    for (const i of plugin.packItems ?? []) {
      if (!(PACK_ITEM_KINDS as readonly string[]).includes(i.kind)) throw new Error(`plug-in ${plugin.id}: "${i.kind}" is not a pack item kind`);
      if (owner.has(i.kind)) throw new Error(`pack item kind "${i.kind}" is installed by plug-ins ${owner.get(i.kind)} and ${plugin.id}`);
      owner.set(i.kind, plugin.id);
    }
  }
}

// The plug-ins mounted by mountPlugins, read when a new account is made.
let loaded: ServerPlugin[] = [];

/** A plug-in's skills that pass the pack checks (checkPackSkill), at most PACK_LIMITS.skills, one per name. */
function checkedSkills(p: ServerPlugin, warn?: (why: string) => void): PackSkill[] {
  const out: PackSkill[] = [];
  for (const [i, raw] of (Array.isArray(p.skills) ? p.skills : []).entries()) {
    const r = checkPackSkill(raw, `skills[${i}]`);
    if ("problems" in r) warn?.(r.problems.join("; "));
    else if (out.length >= PACK_LIMITS.skills) warn?.(`skills[${i}]: a plug-in brings up to ${PACK_LIMITS.skills} skills`);
    else if (out.some((x) => skillNameKey(x.name) === skillNameKey(r.skill.name))) warn?.(`skills[${i}].name: another skill of this plug-in has that name`);
    else out.push(r.skill);
  }
  return out;
}

let skills: { plugin: { id: string; name: string }; skill: PackSkill }[] = [];

/** Every loaded plug-in's skills that passed the checks at mount, in load order. */
export const pluginSkills = (): readonly { plugin: { id: string; name: string }; skill: PackSkill }[] => skills;

/** An upload relay a plug-in adds for Review's big videos: the browser sends the file to it (TUS), then the server takes it over. */
export interface UploadRelay {
  id: string;
  label: string;
  // False when its settings are missing; the server then uses chunked parts.
  available: () => boolean;
  // Starts one upload. `vid` is the relay's own id for it, kept with the upload on this server.
  start: (init: { name: string; mime: string; total: number }) => Promise<{ vid: string; tus: UploadRelayTus }>;
  // Puts the file at `dest` once the relay has all `bytes` of it. Rejects when the relay refused the file.
  place: (vid: string, dest: string, bytes: number) => Promise<void>;
  // Deletes the relay's copy of an upload that will never be finished (the stale-upload sweep calls it).
  abandon: (vid: string) => Promise<void>;
}

/** The upload relays every loaded plug-in adds, in load order. */
export function pluginUploadRelays(): UploadRelay[] {
  return loaded.flatMap((p) => p.uploadRelays ?? []);
}

/** The gates and built-in apps that start switched off for a new role-"user" account, from every loaded plug-in. */
export function pluginDefaultOff(): (PluginGateId | Tool)[] {
  return loaded.flatMap((p) => p.gates?.defaultOff ?? []);
}

/** True when a loaded plug-in turns on the install's own Meta login for this (non-hosted) install. */
export function pluginInstallMetaLogin(): boolean {
  return loaded.some((p) => p.installMetaLogin === true);
}

/** The first loaded plug-in's reason to refuse a Finals piece, or null. A guard that throws refuses (fails closed). */
export async function pluginFinalsRefusal(input: FinalsAdd): Promise<string | null> {
  for (const p of loaded) {
    try {
      const why = await p.finals?.beforeAdd?.(input);
      if (why) return why;
    } catch (e) {
      return `${p.id} refused: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

export interface PostedCheckInput {
  shortcode: string;
  version?: string;
  publication?: "published" | "trial";
}

export interface PostedCheckResult {
  state: "checked" | "feed_busy" | "not_in_feed" | "catalog_failed";
  version?: string;
  matched?: boolean;
  /** true when no version was named, so the version is the catalog's guess */
  guessed?: boolean;
  error?: string;
}

/** One Finals version of a session's piece: its key (the version's id in its own store), its label and its mechanical facts. */
export interface FinalsVersion {
  key: string;
  label: string;
  facts: string;
}

/** The Finals versions every loaded plug-in adds for a session's piece, in load order. A throw is logged and skipped. */
export async function pluginFinalsVersions(sessionId: string, docId: string, mainDocId: string | undefined): Promise<FinalsVersion[]> {
  const out: FinalsVersion[] = [];
  for (const p of loaded) {
    try {
      out.push(...((await p.workshop?.finalsVersions?.(sessionId, docId, mainDocId)) ?? []));
    } catch (e) {
      console.warn(`[plugin] ${p.id} finals versions failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Asks the plug-ins to check a pasted post; the first answer wins, null when none does. A throw is logged and skipped. */
export async function pluginCheckPosted(
  user: SessionUser,
  session: { id: string },
  account: string | null | undefined,
  posted: PostedCheckInput,
): Promise<PostedCheckResult | null> {
  for (const p of loaded) {
    try {
      const out = await p.workshop?.checkPosted?.(user, session, account, posted);
      if (out) return out;
    } catch (e) {
      console.warn(`[plugin] ${p.id} workshop check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return null;
}

/** Tells every loaded plug-in that a piece was added to Finals. A listener that throws (or rejects) is logged and skipped. */
export async function pluginFinalsAdded(input: FinalsAdd, source: FinalsSource, outcome: FinalsOutcome): Promise<void> {
  for (const p of loaded) {
    try {
      await p.finals?.onAdded?.(input, source, outcome);
    } catch (e) {
      console.warn(`[plugin] ${p.id} finals listener failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The per-edit flags every loaded plug-in declares, in load order. */
export function pluginEditFlags(): EditFlag[] {
  return loaded.flatMap((p) => p.editFlags ?? []);
}

/** Refuses an edit flag id that is not lowercase words and dashes, or that two plug-ins both declare. */
function checkEditFlags(plugins: ServerPlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    for (const f of plugin.editFlags ?? []) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(f.id)) throw new Error(`plug-in ${plugin.id}: edit flag "${f.id}" is not lowercase words and dashes`);
      if (seen.has(f.id)) throw new Error(`edit flag "${f.id}" is declared twice`);
      seen.add(f.id);
    }
  }
  const steps = new Set<string>();   // and the editor steps' ids, the same way
  for (const plugin of plugins) {
    for (const st of plugin.editor?.steps ?? []) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(st.id)) throw new Error(`plug-in ${plugin.id}: editor step "${st.id}" is not lowercase words and dashes`);
      if (steps.has(st.id)) throw new Error(`editor step "${st.id}" is declared twice`);
      steps.add(st.id);
    }
  }
}

/** The driver kinds every loaded plug-in adds, in load order. */
export function driverKinds(): DriverKind[] {
  return loaded.flatMap((p) => p.providers?.kinds ?? []);
}

/** The provider presets every loaded plug-in adds, in load order (endpoints included: the server only). */
export function providerPresets(): ProviderPreset[] {
  return loaded.flatMap((p) => p.providers?.presets ?? []);
}

/**
 * Refuses a driver kind or preset id that is not lowercase words and dashes, a kind that is a built-in driver or
 * declared twice, and a preset whose driver is neither a built-in nor a kind a plug-in declares.
 */
function checkProviders(plugins: ServerPlugin[]): void {
  const drivers = new Set<string>(DRIVERS.map((d) => d.id));
  const presets = new Set<string>();
  for (const plugin of plugins) {
    for (const k of plugin.providers?.kinds ?? []) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(k.id)) throw new Error(`plug-in ${plugin.id}: provider kind "${k.id}" is not lowercase words and dashes`);
      if (drivers.has(k.id)) throw new Error(`plug-in ${plugin.id}: provider kind "${k.id}" is already a driver`);
      drivers.add(k.id);
    }
  }
  for (const plugin of plugins) {
    for (const p of plugin.providers?.presets ?? []) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(p.id)) throw new Error(`plug-in ${plugin.id}: provider preset "${p.id}" is not lowercase words and dashes`);
      if (presets.has(p.id)) throw new Error(`provider preset "${p.id}" is declared twice`);
      if (!drivers.has(p.driver)) throw new Error(`plug-in ${plugin.id}: provider preset "${p.id}" uses unknown driver "${p.driver}"`);
      presets.add(p.id);
    }
  }
}

/** Refuses an upload relay id that is not lowercase words and dashes, is a built-in relay, or that two plug-ins both declare. */
function checkUploadRelays(plugins: ServerPlugin[]): void {
  const seen = new Set<string>(["chunked", "direct"]);
  for (const plugin of plugins) {
    for (const r of plugin.uploadRelays ?? []) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(r.id)) throw new Error(`plug-in ${plugin.id}: upload relay "${r.id}" is not lowercase words and dashes`);
      if (seen.has(r.id)) throw new Error(`upload relay "${r.id}" is declared twice or is built in`);
      seen.add(r.id);
    }
  }
}

/** Refuses a gate id that is a built-in app or is declared twice, and a default-off id the plug-in did not declare. */
function checkGates(plugins: ServerPlugin[]): void {
  const owner = new Map<string, string>();
  for (const plugin of plugins) {
    const gates = plugin.gates;
    if (!gates) continue;
    for (const id of gates.ids) {
      if (!isPluginGateId(id)) throw new Error(`plug-in ${plugin.id}: "${id}" is not a gate id (lowercase words and dashes, not a built-in app)`);
      if (owner.has(id)) throw new Error(`gate "${id}" is declared by plug-ins ${owner.get(id)} and ${plugin.id}`);
      owner.set(id, plugin.id);
    }
    for (const id of gates.defaultOff ?? []) {
      if (!gates.ids.includes(id) && !isTool(id)) throw new Error(`plug-in ${plugin.id}: default-off gate "${id}" is not in its gates`);
    }
  }
}

/** Registers each loaded plug-in's public-grid read and account readers (connectors/provider.ts). */
function registerConnectors(plugins: ServerPlugin[]): void {
  for (const plugin of plugins) {
    if (plugin.connectors?.publicGrid) registerPublicGridReader(plugin.connectors.publicGrid);
    for (const r of plugin.connectors?.readers ?? []) if (!readers.includes(r)) registerReader(r);
  }
}

/**
 * Route guard for a plug-in gate: 403 while the account has the gate in its `off` list (users.json). Admins pass;
 * visitors and requests with no account are refused. Put it on each route the gate covers.
 */
export const requireGate = (id: PluginGateId): MiddlewareHandler => async (c, next) => {
  const user = c.get("user") as { role: string; off: string[] } | undefined;
  const allowed = !!user && user.role !== "visitor" && (user.role === "admin" || !user.off.includes(id));
  if (!allowed) return c.json({ error: "This app isn't switched on for your account", code: "GATE_OFF" }, 403);
  await next();
};

/** Mount each plug-in's open routes at the root, before the account gate (boot.ts calls it there). */
export function mountOpenRoutes(app: Hono<any, any, any>, plugins: ServerPlugin[]): void {
  for (const plugin of plugins) if (plugin.openRoutes) app.route("/", plugin.openRoutes);
}

/** Mounts each plug-in's publicRoutes before the account gate. A path must be absolute. */
export function mountPublicRoutes(app: Hono<any, any, any>, plugins: ServerPlugin[]): void {
  for (const plugin of plugins) {
    for (const r of plugin.publicRoutes ?? []) {
      if (!r.path.startsWith("/")) throw new Error(`plug-in ${plugin.id}: public route "${r.path}" must start with /`);
      app.route(r.path, r.app);
    }
  }
}

/** Mounts each plug-in's gatedRoutes after the account gate (the same gate as every /api route). */
export function mountGatedRoutes(app: Hono<any, any, any>, plugins: ServerPlugin[]): void {
  for (const plugin of plugins) {
    for (const r of plugin.gatedRoutes ?? []) {
      if (!r.path.startsWith("/")) throw new Error(`plug-in ${plugin.id}: gated route "${r.path}" must start with /`);
      app.route(r.path, r.app);
    }
  }
}

/**
 * Runs each loaded plug-in's start hook, once, in load order. `around` runs the hook of a plug-in it knows how to
 * contain (one from the person's folder, lib/folder-plugins.ts): there a hook that throws is recorded, not fatal.
 */
export function startPlugins(plugins: ServerPlugin[], around: (plugin: ServerPlugin, run: () => void) => void = (_p, run) => run()): void {
  for (const plugin of plugins) if (plugin.start) around(plugin, () => plugin.start!());
}

/** True when a plug-in lets this request's body go past the 50 MB cap. */
export function pluginBodyLimitExempt(plugins: ServerPlugin[], method: string, path: string): boolean {
  return plugins.some((p) => p.bodyLimitExempt?.(method, path) === true);
}

/** Mount each plug-in's admin routes at /api/admin (boot.ts calls it in hosted mode, before the built-in admin routes). */
export function mountAdminRoutes(app: Hono<any, any, any>, plugins: ServerPlugin[]): void {
  for (const plugin of plugins) if (plugin.adminRoutes) app.route("/api/admin", plugin.adminRoutes);
}

/** The built-in root paths a plug-in may replace (a plug-in's `replaces.paths` must be one of these). */
export const REPLACEABLE_PATHS = ["/api/editor"] as const;

let replaced: ServerPlugin[] = [];

/** Refuses a replaced path that is not in REPLACEABLE_PATHS, or that two plug-ins both replace. */
function checkReplaces(plugins: ServerPlugin[]): void {
  const owner = new Map<string, string>();
  for (const plugin of plugins) {
    for (const p of plugin.replaces?.paths ?? []) {
      if (!(REPLACEABLE_PATHS as readonly string[]).includes(p)) throw new Error(`plug-in ${plugin.id}: ${p} is not a replaceable path`);
      if (owner.has(p)) throw new Error(`path ${p} is replaced by plug-ins ${owner.get(p)} and ${plugin.id}`);
      owner.set(p, plugin.id);
    }
  }
}

/** Mount each plug-in's replaced routes at the built-in root paths (boot.ts calls it before the built-in router of each path). */
export function mountReplacedRoutes(app: Hono<any, any, any>, plugins: ServerPlugin[]): void {
  checkReplaces(plugins);
  replaced = plugins;
  for (const plugin of plugins) {
    for (const p of plugin.replaces?.paths ?? []) app.route(p, plugin.replaces!.routes);
  }
}

/** True when a loaded plug-in replaces this built-in root path (tests of the built-in answer skip then). */
export function pluginReplaces(p: string): boolean {
  return replaced.some((x) => x.replaces?.paths.includes(p) ?? false);
}

/** True when a loaded plug-in allows this request path a body over 50 MB (its own check runs before the body is read). */
export function replacedLargeBody(path: string): boolean {
  return replaced.some((p) => p.replaces?.largeBodies?.some((re) => re.test(path)));
}

/** Mount each plug-in's Media Library routes at /api/library (boot.ts calls it before the core library routers). */
export function mountLibraryRoutes(app: Hono<any, any, any>, plugins: ServerPlugin[]): void {
  for (const plugin of plugins) if (plugin.libraryRoutes) app.route("/api/library", plugin.libraryRoutes);
}

/**
 * GET /api/plugins: the loaded plug-ins for Community → Installed (behind the account gate, like every /api route).
 * Admins also get what each adds. boot.ts mounts it with the other routes, so mounting plug-ins never adds a route late.
 */
export function mountPluginsList(app: Hono<any, any, any>): void {
  app.get("/api/plugins", (c) =>
    c.json({ plugins: describeServerPlugins(loaded, (c.get("user") as { role?: string } | undefined)?.role === "admin") }),
  );
}

/** True when the app already has a route at `base` or under it. */
const pathServed = (app: Hono<any, any, any>, base: string): boolean => app.routes.some((r) => r.path === base || r.path.startsWith(base + "/"));

/**
 * Mount each plug-in's routes at /api/x/<id>. Throws when that path is already served, so a boot never answers one path twice,
 * and when a gate is declared badly. The loaded plug-ins are then the ones new accounts get their default-off gates from.
 */
export function mountPlugins(app: Hono<any, any, any>, plugins: ServerPlugin[]): void {
  checkGates(plugins);
  checkEditFlags(plugins);
  checkProviders(plugins);
  checkUploadRelays(plugins);
  checkPackItems(plugins);
  checkNeeds(plugins);
  loaded = plugins;
  applyNeedWays(plugins.flatMap((p) => (p.needs ?? []).map((n) => wayOf(p, n))));
  skills = plugins.flatMap((p) => checkedSkills(p, (why) => console.warn(`plug-in ${p.id}: a skill is left out: ${why}`)).map((skill) => ({ plugin: { id: p.id, name: p.name ?? p.id }, skill })));
  registerConnectors(plugins);
  for (const plugin of plugins) {
    if (plugin.library) registerLibrarySlot(plugin.id, plugin.library);
    if (!plugin.routes) continue;
    const base = `/api/x/${plugin.id}`;
    if (pathServed(app, base)) throw new Error(`plug-in ${plugin.id}: ${base} is already served`);
    app.route(base, plugin.routes);
  }
}

/** The built-in root paths a plug-in may answer before the built-in router (a plug-in's `answers[].path` must be one of these). */
export const ANSWERABLE_PATHS = ["/api/instagram", "/api/media", "/api/enhance", "/api/review"] as const;

/** Refuses an answered path that is not in ANSWERABLE_PATHS, or that two plug-ins both answer. */
function checkAnswers(plugins: ServerPlugin[]): void {
  const owner = new Map<string, string>();
  for (const plugin of plugins) {
    for (const a of plugin.answers ?? []) {
      if (!(ANSWERABLE_PATHS as readonly string[]).includes(a.path)) throw new Error(`plug-in ${plugin.id}: ${a.path} is not an answerable path`);
      if (owner.has(a.path)) throw new Error(`path ${a.path} is answered by plug-ins ${owner.get(a.path)} and ${plugin.id}`);
      owner.set(a.path, plugin.id);
    }
  }
}

/** Mount each plug-in's answered routes ahead of the built-in router of their path (boot.ts calls it before that router). */
export function mountAnsweredRoutes(app: Hono<any, any, any>, plugins: ServerPlugin[]): void {
  checkAnswers(plugins);
  for (const plugin of plugins) for (const a of plugin.answers ?? []) app.route(a.path, a.routes);
}

/**
 * Why a plug-in can't join the ones already in, or null. It runs, on this one plug-in, every check that otherwise stops
 * the server when it starts: an id, gate, edit flag, provider, upload relay, pack kind, replaced or answered path, or
 * Media Library source or filter that another plug-in has, a route path without its /, and routes that are not a Hono app. So a plug-in from the person's own
 * folder (lib/folder-plugins.ts) is left out with this sentence and the app starts without it. `more` is for the checks
 * this file can't import (the AI tools, api/mcp.ts).
 */
export function admissionProblem(admitted: ServerPlugin[], candidate: ServerPlugin, more?: (all: ServerPlugin[]) => void): string | null {
  try {
    if (!candidate || typeof candidate !== "object") throw new Error("its file must export definePlugin({ … }) as the default");
    if (typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(candidate.id)) throw new Error("its id must be lowercase letters, digits and dashes");
    if (admitted.some((p) => p.id === candidate.id)) throw new Error(`the app already has a plug-in called ${candidate.id}`);
    const all = [...admitted, candidate];
    checkGates(all);
    checkEditFlags(all);
    checkProviders(all);
    checkUploadRelays(all);
    checkPackItems(all);
    checkNeeds(all);
    checkReplaces(all);
    checkAnswers(all);
    checkLibrarySlots(all.flatMap((p) => (p.library ? [[p.id, p.library] as [string, LibrarySlot]] : [])));
    // read on every request (replacedLargeBody): anything but a RegExp there would fail them all
    for (const re of candidate.replaces?.largeBodies ?? []) if (!(re instanceof RegExp)) throw new Error("replaces.largeBodies must be regular expressions");
    const paths = [...(candidate.publicRoutes ?? []), ...(candidate.gatedRoutes ?? [])];
    for (const r of paths) if (typeof r?.path !== "string" || !r.path.startsWith("/")) throw new Error(`route "${String(r?.path)}" must start with /`);
    // one public-grid reader for the whole app (registerPublicGridReader throws on a second one, at mount)
    const grids = all.filter((p) => p.connectors?.publicGrid);
    if (candidate.connectors?.publicGrid && grids.length > 1) throw new Error(`plug-in ${grids[0]!.id} already reads public grids, and only one can`);
    // Every set of routes is mounted on a throwaway app the way boot.ts mounts the real ones, in its order, with the
    // check mountPlugins makes. So what isn't a Hono app fails here, and so does a plug-in whose open or public
    // routes already serve /api/x/<id> (a webhook written there): at mount that stops the whole server.
    const trial = new HonoApp();
    for (const p of all) {
      if (p.openRoutes) trial.route("/", p.openRoutes);
      for (const r of p.publicRoutes ?? []) trial.route(r.path, r.app);
      for (const a of p.answers ?? []) trial.route(a.path, a.routes);
      if (p.libraryRoutes) trial.route("/api/library", p.libraryRoutes);
      for (const at of p.replaces?.paths ?? []) trial.route(at, p.replaces!.routes);
    }
    for (const p of all) {
      if (!p.routes) continue;
      const base = `/api/x/${p.id}`;
      if (pathServed(trial, base)) throw new Error(`${base} is already served by open or public routes, so the routes of ${p.id} can't be mounted there`);
      trial.route(base, p.routes);
    }
    for (const r of [candidate.adminRoutes, ...(candidate.gatedRoutes ?? []).map((g) => g.app)]) if (r !== undefined) trial.route("/x", r);
    for (const key of ["start", "activity", "menu", "bodyLimitExempt"] as const) {
      if (candidate[key] !== undefined && typeof candidate[key] !== "function") throw new Error(`${key} must be a function`);
    }
    more?.(all);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The first loaded plug-in's footage target for this account (editor.ingest), or null for the default. */
export async function pluginFootageTarget(username: string): Promise<FootageTarget | null> {
  for (const p of loaded) {
    const target = await p.editor?.footageTarget?.(username);
    if (target) return target;
  }
  return null;
}
