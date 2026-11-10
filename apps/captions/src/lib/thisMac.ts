// This Mac's AI, as the Mac app reports it to the page. Only the Mac app has the bridge ("thisMac" handler, TitleBar.swift);
// in a browser there is none and the functions answer null.

/** `device`: this Mac's device id on the open server, once paired (null before that). */
export type ThisMacState = { aiOn: boolean; paired: boolean; problem?: string | null; device?: string | null };
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
/** Shows the plug-in's folder in Finder ("" = the plug-ins folder). */
export const showPluginFolder = (folder: string) => pluginAsk(`plugin:show:${folder}`);
