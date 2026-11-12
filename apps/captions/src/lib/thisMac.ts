// This Mac's AI, as the Mac app reports it to the page. Only the Mac app has the bridge ("thisMac" handler, TitleBar.swift);
// in a browser there is none and the functions answer null.

/** `device`: this Mac's device id on the open server, once paired (null before that). */
export type ThisMacState = { aiOn: boolean; paired: boolean; problem?: string | null; device?: string | null; linked?: boolean };
type Bridge = { postMessage: (m: string) => Promise<ThisMacState> };

/** The Mac app's bridge, or undefined in a browser (no window at all in a test). */
export function thisMacBridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { webkit?: { messageHandlers?: { thisMac?: Bridge } } }).webkit?.messageHandlers?.thisMac;
}

/**
 * Turns this Mac's AI on and pairs it with this server (the Mac app does both, then answers). Resolves once the
 * device exists, so the next AI check can find it. null in a browser or when the Mac app does not answer.
 * Setup calls it before connecting an AI on a Mac app's first run (AiPanel.tsx).
 */
export async function startThisMac(): Promise<ThisMacState | null> {
  const bridge = thisMacBridge();
  if (!bridge) return null;
  try {
    return await bridge.postMessage("start");
  } catch {
    return null;
  }
}

/**
 * "Choose a folder" in the Mac app: its own open panel (ThisMacBridge.swift chooseFolder). Resolves to the folder's path,
 * or null when it was cancelled. undefined in a browser, where the page asks for a typed path instead.
 */
export async function chooseFolderOnMac(): Promise<string | null | undefined> {
  const bridge = thisMacBridge();
  if (!bridge) return undefined;
  try {
    const reply = (await (bridge.postMessage("folder") as unknown as Promise<{ path?: string | null }>)) ?? {};
    return reply.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Where a file picked in the Mac app's own open panel is on this Mac (ThisMacBridge.swift pickedFilesReply), so the
 * server can add it in place instead of taking an upload. Matched by name and size (and the time it was last changed
 * when two picked files share both). undefined in a browser, in a Mac app from before it could say (it answers every
 * unknown question with its state), on a server that is not this Mac, or when the match is not sure: then the page uploads.
 */
export async function pathOnMac(file: File): Promise<string | undefined> {
  const bridge = thisMacBridge();
  if (!bridge) return undefined;
  try {
    const r = ((await bridge.postMessage("files")) ?? {}) as unknown as { files?: unknown };
    const picked = Array.isArray(r.files) ? (r.files as { path?: unknown; name?: unknown; size?: unknown; modified?: unknown }[]) : [];
    // one form of accented letters on both sides: the Mac's file names and the page's may differ (õ, ä)
    const name = file.name.normalize("NFC");
    const same = picked.filter((f) => typeof f?.path === "string" && typeof f.name === "string" && f.name.normalize("NFC") === name && f.size === file.size);
    const one = same.length > 1 ? same.filter((f) => Math.abs(Number(f.modified) - file.lastModified) < 2000) : same;
    return one.length === 1 ? (one[0].path as string) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Finder folders of the drag just dropped on the window (AppWebView.dragItems): their paths, so a folder is pointed
 * at where it lies instead of uploaded. undefined in a browser or a Mac app from before it could; [] when none.
 */
export async function droppedFoldersOnMac(): Promise<string[] | undefined> {
  const bridge = thisMacBridge();
  if (!bridge) return undefined;
  try {
    const r = ((await bridge.postMessage("dropped")) ?? {}) as unknown as { items?: Array<{ path?: unknown; folder?: unknown }> };
    if (!Array.isArray(r.items)) return undefined;
    return r.items.filter((x) => x.folder === true && typeof x.path === "string").map((x) => x.path as string);
  } catch {
    return undefined;
  }
}

/**
 * Headless access → Install on a server that is not this computer: the Mac app adds the open server to Claude Code or
 * Codex on this Mac itself (ThisMacBridge.swift installInAI), with the key the page just made for that app. true = done;
 * a sentence = why not; undefined = no Mac app here, or one from before it could (the page then shows the line to run).
 */
export async function installInMacAi(app: "claude" | "codex", key: string): Promise<true | string | undefined> {
  const bridge = thisMacBridge();
  if (!bridge) return undefined;
  try {
    const r = ((await bridge.postMessage(`install:${app}:${key}`)) ?? {}) as unknown as { ok?: boolean; problem?: string };
    return r.ok === true ? true : r.ok === false ? r.problem || "It didn't work. Try again." : undefined;
  } catch {
    return undefined;
  }
}

/**
 * "Access from other devices" on this Mac: the server starts listening beyond this computer (the Mac app asks for the
 * owner's password first, when there is none). Resolves to the problem to show, or null when it is on and the server
 * is restarting.
 */
export async function allowOtherDevices(): Promise<string | null> {
  const bridge = thisMacBridge();
  if (!bridge) return "Turn on Access from other devices in the Creator Toolset Mac app.";
  try {
    const s = await bridge.postMessage("access");
    return s.problem ?? null;
  } catch {
    return "The Creator Toolset Mac app did not answer. Try again.";
  }
}

/**
 * Whether this Mac is on an account through the connect service: true or false from the Mac app, undefined in a browser
 * or from an app too old to say (setup then shows no Add this computer).
 */
export async function thisMacLinked(): Promise<boolean | undefined> {
  try {
    const s = await thisMacBridge()?.postMessage("state");
    return typeof s?.linked === "boolean" ? s.linked : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Setup's Add this computer: the Mac app opens the site's page with this Mac's code in the browser, waits for the yes and
 * starts this Mac's tunnel (the Servers menu's Add this Mac to my account…). Resolves to null once it is on the account,
 * else the problem to show.
 */
export async function connectThisMac(): Promise<string | null> {
  const bridge = thisMacBridge();
  if (!bridge) return "Open Creator Toolset on this Mac to add it.";
  try {
    const s = await bridge.postMessage("connect");
    return s.linked ? null : `This Mac was not added: ${s.problem ?? "try again"}`;
  } catch {
    return "The Creator Toolset Mac app did not answer. Try again.";
  }
}

/** The Mac app's answer to a plug-in ask: done, or why not. No `problem` on a plain no (the person pressed Cancel). */
export type PluginReply = { ok: boolean; problem?: string };

/**
 * Plug-ins from the person's folder are switched on and off by the Mac app, never by a page: Switch on is the app's own
 * dialog, and the app keeps the record of that click (apps/mac Plugins.swift). After a yes the app restarts its server
 * and reloads this window. null in a browser, where there is no switch.
 */
async function pluginAsk(ask: string): Promise<PluginReply | null> {
  const bridge = thisMacBridge();
  if (!bridge) return null;
  try {
    const r = ((await bridge.postMessage(ask)) ?? {}) as unknown as Partial<PluginReply>;
    return { ok: r.ok === true, problem: typeof r.problem === "string" ? r.problem : undefined };
  } catch {
    return { ok: false, problem: "The Creator Toolset Mac app did not answer. Try again." };
  }
}
/** Switch on (or take the new version of) the plug-in in this folder of the plug-ins folder. */
export const switchPluginOn = (folder: string) => pluginAsk(`plugin:on:${folder}`);
export const switchPluginOff = (id: string) => pluginAsk(`plugin:off:${id}`);
/** After the app switched every plug-in off (its server stopped five times): on again. */
export const resumePlugins = () => pluginAsk("plugins:resume");
/**
 * Update automatically, as the Mac app keeps it (with the record of the clicks): whether a plug-in that is on takes up
 * the changes to its folder by itself, the folder each one was switched on from (only that folder's changes come in
 * by themselves), which plug-ins have a new version waiting for the server to have nothing running, and why a folder's
 * newest state was not taken. null in a browser, or when the Mac app does not answer.
 */
export type PluginsAuto = {
  auto: boolean;
  folders: Record<string, string>;
  waiting: string[];
  notes: Record<string, string>;
  /** The app switched every plug-in off itself, after its server stopped five times (not the person, in This Mac). */
  crashed: boolean;
};
export async function pluginsAuto(): Promise<PluginsAuto | null> {
  const bridge = thisMacBridge();
  if (!bridge) return null;
  try {
    const r = ((await bridge.postMessage("plugins:state")) ?? {}) as unknown as Partial<PluginsAuto> & { ok?: boolean };
    if (r.ok !== true || typeof r.auto !== "boolean") return null;
    const map = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, string>) : {});
    return { auto: r.auto, folders: map(r.folders), waiting: Array.isArray(r.waiting) ? r.waiting : [], notes: map(r.notes), crashed: r.crashed === true };
  } catch {
    return null;
  }
}
/** Switching it on is answered by the Mac app's own dialog (a plug-in's pages run in this page too); off needs none. */
export const setPluginsAuto = (on: boolean) => pluginAsk(`plugins:auto:${on ? "on" : "off"}`);
/** Shows the plug-in's folder in Finder ("" = the plug-ins folder). */
export const showPluginFolder = (folder: string) => pluginAsk(`plugin:show:${folder}`);
