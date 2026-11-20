// This Mac's AI, as the Mac app reports it to the page. Only the Mac app has the bridge ("thisMac" handler, TitleBar.swift);
// in a browser there is none and the functions answer null.

import { currentWorkspace } from "@/lib/current-workspace";
import type { PlacesCheckAnswer, PlacesCheckAsk, PlacesConnectAnswer, PlacesConnectAsk, PlacesSearchAsk, PlacesSearchState } from "@contracts/places";

/** `device`: this Mac's device id on the open server, once paired (null before that). */
export type ThisMacState = { aiOn: boolean; paired: boolean; problem?: string | null; device?: string | null; linked?: boolean; pairs?: boolean; computer?: string };
type Bridge = { postMessage: (m: string) => Promise<ThisMacState> };

/**
 * The Mac app's own page: its mark on <html> (data-mac-reveal, apps/mac Reveal.swift) and its bridge. The one test for
 * "this page is the Mac app" that Show in Finder (pages/library/clip.ts canReveal) and the in-place drops (lib/library.ts
 * macIndexOnly) both use, so they never disagree.
 */
export const macPageMarked = (): boolean => {
  const mark = typeof document === "undefined" ? undefined : document.documentElement.dataset.macReveal;
  return (mark === "1" || mark === "2") && !!thisMacBridge();
};

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

/** This Mac's state on the open server; null in a browser. */
export async function thisMacState(): Promise<ThisMacState | null> {
  const bridge = thisMacBridge();
  return bridge ? bridge.postMessage("state").catch(() => null) : null;
}

/**
 * Adds this Mac to the open server as one of the person's computers, its AI left as it is (a press in Settings →
 * Folders: a folder on this Mac needs it). null when the app can't (a browser, or an app from before that only pairs
 * with the AI on: never asked then, its "pair" would switch the AI on).
 */
export async function pairThisMac(): Promise<ThisMacState | null> {
  const s = await thisMacState();
  if (!s?.pairs) return null;
  return s.paired ? s : thisMacBridge()!.postMessage("pair").catch(() => null);
}

/** The server's answer when no Mac of the person's own is on for a call (api/designs.ts fromMac): `device` is the Mac of theirs it can't reach. */
type NoMac = Error & { code?: string; device?: { id: string; name: string } };
const noMac = (e: unknown): e is NoMac => e instanceof Error && (e as NoMac).code === "no_mac";

/**
 * A call that needs a Mac of the person's own (a cut-out, a split). Inside the Mac app, when the server sees no Mac of
 * theirs, it is done on this Mac: `onHere` is told so first ("Ana's Mac Studio is unreachable. Doing it on this Mac.",
 * or this Mac isn't connected to this server), this Mac is switched on for it (Settings → Computers, Take work from this server, which adds
 * it to this server) and the call is made again once the server sees it. `signal` stops the waiting. In a browser, or
 * for any other answer, the call's own error.
 */
export async function onThisMac<T>(run: () => Promise<T>, opts: { onHere?: (why: string) => void; signal?: AbortSignal; wait?: number; tries?: number } = {}): Promise<T> {
  const { wait = 1500, tries = 8, signal } = opts;
  try {
    return await run();
  } catch (e) {
    const bridge = thisMacBridge();
    if (!bridge || !noMac(e)) throw e;
    const here = await bridge.postMessage("state").catch(() => null);
    // another Mac is named only when this one is on this server under an id of its own: a Mac not on it yet (no id here)
    // may well be the one the server knows by name, from an older app or an earlier pairing
    const other = e.device && here?.device && e.device.id !== here.device;
    opts.onHere?.(other ? `${e.device!.name} is unreachable. Doing it on this Mac.` : "This Mac isn't connected to this server. Connecting it and doing it here.");
    const s = await startThisMac();
    if (!s?.aiOn || !s.paired) throw new Error(s?.problem ? `This Mac could not start taking work from this server: ${s.problem}` : e.message);
    // the server sees the Mac at its first call, a moment after it is switched on
    for (let n = 1; ; n++) {
      await new Promise((r) => setTimeout(r, wait));
      signal?.throwIfAborted();
      try {
        return await run();
      } catch (again) {
        if (n >= tries || !noMac(again)) throw again;
      }
    }
  }
}

/**
 * "Choose a folder" in the Mac app: its own open panel (ThisMacBridge.swift chooseFolder). Resolves to the folder's path,
 * or null when it was cancelled. undefined in a browser, where the page asks for a typed path instead.
 */
export async function chooseFolderOnMac(): Promise<string | null | undefined> {
  return pathAskOnMac("folder");
}

/** A folder picked in the Mac app's open panel, with the names of the folders in it and beside it (a Mac app from before
 *  sends no names: then nothing is known to be there). */
export type PickedFolder = { path: string; children?: string[]; siblings?: string[] };
/** chooseFolderOnMac with the folder's subfolder names, for setup's Library folder (Found or Will be created). */
export async function pickFolderOnMac(): Promise<PickedFolder | null | undefined> {
  const bridge = thisMacBridge();
  if (!bridge) return undefined;
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  try {
    const r = ((await (bridge.postMessage("folder") as unknown as Promise<{ path?: string | null; children?: unknown; siblings?: unknown }>)) ?? {}) as { path?: string | null; children?: unknown; siblings?: unknown };
    if (!r.path) return null;
    const children = names(r.children);
    const siblings = names(r.siblings);
    return { path: r.path, ...(children ? { children } : {}), ...(siblings ? { siblings } : {}) };
  } catch {
    return null;
  }
}

/**
 * Settings → Storage › This computer, Download location › Change…: this Mac's own folder panel for the download cache
 * (ThisMacBridge.swift chooseDownloadFolder). The same answer shape as chooseFolderOnMac.
 */
export async function chooseDownloadFolderOnMac(): Promise<string | null | undefined> {
  return pathAskOnMac("download-folder");
}

async function pathAskOnMac(what: string): Promise<string | null | undefined> {
  const bridge = thisMacBridge();
  if (!bridge) return undefined;
  try {
    const reply = (await (bridge.postMessage(what) as unknown as Promise<{ path?: string | null }>)) ?? {};
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
 * The Finder files and folders of the drag just dropped on the window (AppWebView.dragItems): their paths, so a folder is
 * pointed at where it lies instead of uploaded, and a file's reply needn't wait for its upload. undefined in a browser or
 * a Mac app from before it could; [] when none.
 */
export async function droppedOnMac(o: { chosen?: boolean } = {}): Promise<Array<{ path: string; folder: boolean }> | undefined> {
  const bridge = thisMacBridge();
  if (!bridge) return undefined;
  try {
    const r = ((await bridge.postMessage("dropped")) ?? {}) as unknown as { items?: Array<{ path?: unknown; folder?: unknown }> };
    if (!Array.isArray(r.items)) return undefined;
    const items = r.items.flatMap((x) => (typeof x.path === "string" ? [{ path: x.path, folder: x.folder === true }] : []));
    // `chosen` (a chat's drop): its workspace, so the AI Editor copies these in only for an edit of it (MediaFiles.chosen);
    // an older app ignores it. Any other drop (setup's folder, the Library's own) gives the AI Editor nothing
    const workspace = o.chosen ? currentWorkspace() : null;
    if (workspace && items.length) void bridge.postMessage(`import:chosen:${JSON.stringify({ workspace, paths: items.map((i) => i.path) })}`).catch(() => {});
    return items;
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
 * Settings → Providers → Install for an AI on this Mac while the window shows a server that is not this Mac: the Mac app
 * runs the installer itself (ThisMacBridge.swift AiInstall). true = installed; a sentence = why not.
 */
export async function installAiOnMac(id: "claude" | "codex" | "gemini" | "antigravity"): Promise<true | string> {
  const bridge = thisMacBridge();
  if (!bridge) return "Open this page in the Mac app to install it.";
  try {
    const r = ((await bridge.postMessage(`ai-install:${id}`)) ?? {}) as unknown as { ok?: boolean; problem?: string };
    return r.ok === true ? true : r.problem || "Could not install it. Try again.";
  } catch {
    return "Could not install it. Try again.";
  }
}

/**
 * The install's download so far ({ done, total }; 0 of 0 when none runs), or null when the Mac app can't install AIs for
 * the page: a browser, or a Mac app from before it could (it answers an ask it doesn't know as switched off).
 */
export async function aiInstallProgressOnMac(): Promise<{ done: number; total: number } | null> {
  const bridge = thisMacBridge();
  if (!bridge) return null;
  try {
    const r = ((await bridge.postMessage("ai-install-progress")) ?? {}) as unknown as { done?: unknown; total?: unknown };
    return typeof r.done === "number" && typeof r.total === "number" ? { done: r.done, total: r.total } : null;
  } catch {
    return null;
  }
}

/**
 * "Network access" on this Mac: the server starts listening beyond this computer (the Mac app asks for the
 * owner's password first, when there is none). Resolves to the problem to show, or null when it is on and the server
 * is restarting.
 */
export async function allowOtherDevices(): Promise<string | null> {
  const bridge = thisMacBridge();
  if (!bridge) return "Turn on Network access in the Creator Toolset Mac app.";
  try {
    const s = await bridge.postMessage("access");
    return s.problem ?? null;
  } catch {
    return "Could not reach the Creator Toolset Mac app. Try again.";
  }
}

/** Asks the Mac app something that answers with its state: the problem to show, or null when done. */
async function macAsk(ask: string, away: string): Promise<string | null> {
  const bridge = thisMacBridge();
  if (!bridge) return away;
  try {
    return (await bridge.postMessage(ask)).problem ?? null;
  } catch {
    return "Could not reach the Creator Toolset Mac app. Try again.";
  }
}

/** Settings → Computers → Network access, both ways: the Mac app restarts its server listening on the network or on this Mac only. */
export const setNetworkAccess = (on: boolean) => macAsk(on ? "access" : "access:off", "Change Network access in the Creator Toolset Mac app.");

/** Reach from anywhere: the Mac app links this Mac to the account it is signed in to (its tunnel), or unlinks it. */
export const setReachFromAnywhere = (on: boolean) => macAsk(on ? "connect.link" : "connect.unlink", "Open Creator Toolset on this Mac to change it.");

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
 * starts this Mac's tunnel (the Servers menu's Add this Mac to the account…). Resolves to null once it is on the account,
 * else the problem to show.
 */
export async function connectThisMac(): Promise<string | null> {
  const bridge = thisMacBridge();
  if (!bridge) return "Open Creator Toolset on this Mac to add it.";
  try {
    const s = await bridge.postMessage("connect");
    return s.linked ? null : `This Mac was not added: ${s.problem ?? "try again"}`;
  } catch {
    return "Could not reach the Creator Toolset Mac app. Try again.";
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
    return { ok: false, problem: "Could not reach the Creator Toolset Mac app. Try again." };
  }
}
/** Switch on (or take the new version of) the plug-in in this folder of the plug-ins folder. */
export const switchPluginOn = (folder: string) => pluginAsk(`plugin:on:${folder}`);
export const switchPluginOff = (id: string) => pluginAsk(`plugin:off:${id}`);
/**
 * Remove, for good (a plug-in row's ⋯ → Remove): the server deletes its folder and the copies the app took of it. One
 * that is on is then switched off by the Mac app, which restarts its server and reloads this window; one that is off
 * restarts nothing, and the caller reads its list again. What the plug-in saved or made stays.
 */
export async function removePlugin(folder: string, on: boolean): Promise<PluginReply> {
  const r = await fetch(`/api/plugins/folder/${encodeURIComponent(folder)}`, { method: "DELETE" });
  const j = (await r.json().catch(() => null)) as { id?: string | null; error?: string } | null;
  if (!r.ok) return { ok: false, problem: j?.error ?? "Could not remove it. Try again." };
  if (!on || !j?.id) return { ok: true };
  return (await switchPluginOff(j.id)) ?? { ok: false, problem: "Removed. It stops when the Creator Toolset Mac app restarts its server." };
}
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

/**
 * Face Blur on this Mac (editor-steps/blur-faces/README.md): the Mac app finds and covers the faces in files on this Mac
 * itself and writes the covered copy beside each one. The page starts a job, reads its state, and answers with the faces
 * to cover.
 */
/** `picture` only from faceBlurFaces: the state the page polls leaves the pictures out. */
export type FaceBlurFace = { id: string; picture?: string; note: string; blur: boolean };
export type FaceBlurItem = {
  path: string;
  name: string;
  stage: "queued" | "scanning" | "choosing" | "writing" | "done" | "failed";
  progress: number;
  faces?: FaceBlurFace[];
  out?: string;
  error?: string;
  /** a done file that wrote nothing ("No face found, nothing written") */
  note?: string;
};
/** One ask; throws with the Mac's sentence when it answers with a problem. */
async function faceBlurAsk(ask: string): Promise<Record<string, unknown>> {
  const bridge = thisMacBridge();
  if (!bridge) throw new Error("Face Blur runs in the Creator Toolset Mac app.");
  let r: Record<string, unknown>;
  try {
    r = ((await bridge.postMessage(ask)) ?? {}) as unknown as Record<string, unknown>;
  } catch {
    throw new Error("Could not reach the Creator Toolset Mac app. Try again.");
  }
  if (typeof r.problem === "string") throw new Error(r.problem);
  return r;
}
/** "ok": this Mac app covers faces; "old": a Mac app from before it could (it answers with its state); "none": a browser. */
export async function faceBlurHere(): Promise<"ok" | "old" | "none"> {
  const v = await faceBlurVersion();
  return v === null ? "none" : v > 0 ? "ok" : "old";
}
/** What this Mac app's Face Blur can do: 1 = cover files, 2 = also styles and test runs (faceBlurTry); 0 = none (an older
 * app); null in a browser. */
export async function faceBlurVersion(): Promise<number | null> {
  if (!thisMacBridge()) return null;
  const r = await faceBlurAsk("faceblur:hello").catch(() => null);
  return r?.ok === true ? (typeof r.version === "number" ? r.version : 1) : 0;
}
/** The look and its adjustments (plug-in Settings: look, strength, softness, size, color). */
export type FaceBlurStyle = { look: string; strength: number; softness: number; size: number; color: string };
/** Starts covering these files (paths on this Mac); the job's id, or throws with the Mac's reason. A Mac app before
 * styles (version 1) reads only the look. */
export async function faceBlurStart(files: string[], mode: "all" | "some", style: FaceBlurStyle): Promise<string> {
  const r = await faceBlurAsk(`faceblur:start:${JSON.stringify({ files, mode, ...style })}`);
  if (typeof r.job !== "string") throw new Error("The Mac app did not start. Try again.");
  return r.job;
}
export async function faceBlurState(job: string): Promise<{ done: boolean; items: FaceBlurItem[] }> {
  const r = await faceBlurAsk(`faceblur:state:${job}`);
  return { done: r.done === true, items: Array.isArray(r.items) ? (r.items as FaceBlurItem[]) : [] };
}
/** One file's faces with their pictures (read once; the state leaves them out). */
export async function faceBlurFaces(job: string, path: string): Promise<FaceBlurFace[]> {
  const r = await faceBlurAsk(`faceblur:faces:${JSON.stringify({ job, path })}`);
  return Array.isArray(r.faces) ? (r.faces as FaceBlurFace[]) : [];
}
/** Writes (again) one file of the job with these faces covered. `error`: the pick failed; the Mac ends that file as
 * failed with this sentence and writes nothing. */
export const faceBlurChoose = (job: string, path: string, blur: string[], error?: string) =>
  faceBlurAsk(`faceblur:choose:${JSON.stringify({ job, path, blur, ...(error ? { error } : {}) })}`);
export const faceBlurCancel = (job: string) => faceBlurAsk(`faceblur:cancel:${job}`);
export const faceBlurShow = (path: string) => faceBlurAsk(`faceblur:show:${path}`);
/** Choose files in the Mac app's own open panel, whatever server the window shows: their paths ([] when cancelled), or
 * null from a Mac app from before it could (the page's own file input then, which gives paths on this Mac's own server). */
export async function faceBlurPick(): Promise<string[] | null> {
  const r = await faceBlurAsk("faceblur:pick").catch(() => null);
  return r && Array.isArray(r.paths) ? (r.paths as string[]) : null;
}
/** A preview or a test run on this Mac, written nowhere. */
export type FaceBlurTrial = { kind: "photo" | "video"; faces: { id: string; picture: string; note: string }[]; frames: string[] };
/**
 * The covered result as pictures (base64 JPEGs: the photo, or three moments of a video) and the faces found, for `picture`
 * (base64, the example) or `path` (a file picked in this app), in `style`. `blur`: the faces to cover (left out = all);
 * `facesOnly`: just the faces. Throws with the Mac's reason. Needs faceBlurVersion() ≥ 2.
 */
export async function faceBlurTry(
  source: { picture: string } | { path: string },
  style: FaceBlurStyle,
  opts: { blur?: string[]; facesOnly?: boolean } = {},
): Promise<FaceBlurTrial> {
  const r = await faceBlurAsk(`faceblur:try:${JSON.stringify({ ...source, ...style, ...opts })}`);
  return { kind: r.kind === "video" ? "video" : "photo", faces: Array.isArray(r.faces) ? (r.faces as FaceBlurTrial["faces"]) : [], frames: Array.isArray(r.frames) ? (r.frames as string[]) : [] };
}

/**
 * Media Library imports on this Mac (the Mac app's import asks): copy files into the library's folder, read the media
 * files under a place again, and fingerprint files by path. Only a Mac app that has them says so on the page
 * (`<html data-mac-import="1">`); an older one answers every ask with its state.
 */
export const macImports = () => typeof document !== "undefined" && document.documentElement.dataset.macImport === "1";

/** One import ask (or another ask the Mac app says it has, `on`); throws with the Mac's reason. */
async function importAsk<T>(ask: string, on = macImports()): Promise<T> {
  const bridge = thisMacBridge();
  if (!bridge || !on) throw new Error("Needs the latest Mac app");
  let r: Record<string, unknown>;
  try {
    r = ((await bridge.postMessage(ask)) ?? {}) as unknown as Record<string, unknown>;
  } catch {
    throw new Error("Could not reach the Creator Toolset Mac app. Try again.");
  }
  if (typeof r.error === "string") throw new Error(r.error);
  return r as T;
}

/** The Mac app's answer to a copy into a folder it doesn't copy into (Import.swift): a release before a Media folder's
 *  Imports/ was one, for a Media folder added with Allow on this Mac. The file is then used where it is. */
export const NOT_A_COPY_FOLDER = "Not a folder this app copies into.";

/** The Mac app's refusals about the file itself (Import.swift copy): in a Media folder already, another workspace's or
 *  server's, or not one it can vouch for as dropped or picked here. Shown as they are, never worked around by uploading
 *  the file instead. */
export const FILE_REFUSED = / is in the Media folder .*: drop the folder with the footage itself$|^Not a file from a drop or a pick in this window\.$/;

export type ImportCopied = { copied: { from: string; to: string }[]; failed: { from: string; error: string }[]; stopped?: boolean };
/** Copies each `from` to `to` ("~/" is this Mac's home folder), never over another file; answers when all are done. */
export const importCopy = (id: string, files: { from: string; to: string }[]) =>
  importAsk<ImportCopied>(`import:copy:${JSON.stringify({ id, files })}`).then((r) => ({ copied: r.copied ?? [], failed: r.failed ?? [], stopped: r.stopped }));
export const importProgress = (id: string) => importAsk<{ bytes: number; of: number; file?: string }>(`import:progress:${id}`);
/**
 * Makes the named folders inside `folder` on this Mac where they are missing (setup's Library folder, on Done): `folder` is
 * one picked in its open panel, or the library's own default place, or the folder beside a picked one. A Mac app from
 * before answers it as unknown: the caller then leaves the folders to be made by the first copy into them.
 */
export const importMake = (folder: string, names: string[]) =>
  importAsk<{ made?: string[]; failed?: { name: string; error: string }[]; children?: string[] }>(`import:make:${JSON.stringify({ in: folder, names })}`).then((r) => ({
    made: r.made ?? [],
    failed: r.failed ?? [],
    // the folders in it afterwards (no names asked: just what is there), for Found
    children: Array.isArray(r.children) ? r.children : undefined,
  }));
/** Stops a copy; the file it was writing is removed. */
export const importCancel = (id: string) => importAsk<unknown>(`import:cancel:${id}`);
/** The media files under a place on this Mac (one the person dropped or picked before). */
export const importScan = (path: string) =>
  importAsk<{ files?: { path: string; size: number; mtime: number }[] }>(`import:scan:${JSON.stringify({ path })}`).then((r) => r.files ?? []);
/** Each path's fingerprint, the one lib/onMac.ts quickPrint makes from the file. */
/** A picture's thumbnail made by macOS (Import.swift thumb: HEIC, RAW), for a file in a folder this app may read; null when it can't. */
export const importThumb = (path: string, max = 480) =>
  importAsk<{ thumb?: string; width?: number; height?: number }>(`import:thumb:${JSON.stringify({ path, max })}`).then(
    (r) => (r.thumb ? { thumb: r.thumb, width: r.width ?? 0, height: r.height ?? 0 } : null),
    () => null,
  );
export const importPrint = (paths: string[]) =>
  importAsk<{ prints?: Record<string, string> }>(`import:print:${JSON.stringify({ paths })}`).then((r) => r.prints ?? {});
/** Locate… (apps/mac Locate.swift): which of `files` are gone from their path here, and the files in `folder` of their sizes with fingerprints. */
export const importLocate = (files: { id: string; path: string; bytes: number }[], folder?: string) =>
  importAsk<{ gone?: string[]; files?: { path: string; size: number; quick: string }[] }>(`import:locate:${JSON.stringify({ folder, files })}`).then((r) => ({
    gone: r.gone ?? [],
    files: r.files ?? [],
  }));

/** The address the page reads a file on this Mac by (the Mac app's media scheme): the path, base64url. */
export const macMediaUrl = (path: string) =>
  `ctlocal://media/${btoa(String.fromCharCode(...new TextEncoder().encode(path))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

/**
 * Here or away (contracts/places.ts): the Mac app checks where a clip's original is on this computer and connects a
 * share. Only a Mac app that answers these says so (`<html data-mac-places="1">`).
 */
export const macPlaces = () => typeof document !== "undefined" && Number(document.documentElement.dataset.macPlaces) >= 1;
/** What this computer has of each version's original; versions it has nothing to say about are left out. */
export const placesCheck = (ask: PlacesCheckAsk) =>
  importAsk<Partial<PlacesCheckAnswer>>(`places:check:${JSON.stringify(ask)}`, macPlaces()).then((r) => r.versions ?? {});
/** Connects a share (its root key), the login panel allowed: only from a Connect button pressed. */
export const placesConnect = (root: string) =>
  importAsk<PlacesConnectAnswer>(`places:connect:${JSON.stringify({ root } satisfies PlacesConnectAsk)}`, macPlaces());
/** Find missing files (apps/mac PlacesSearch.swift): a Mac app with it marks `data-mac-places` "2". */
export const macSearch = () => typeof document !== "undefined" && Number(document.documentElement.dataset.macPlaces) >= 2;
/** Starts Find missing files for a library (one at a time on this Mac); answers how far it is. */
export const placesSearch = (library: string) => importAsk<PlacesSearchState>(`places:search:${JSON.stringify({ library } satisfies PlacesSearchAsk)}`, macSearch());
/** How far this Mac's Find missing files is. */
export const placesSearchState = () => importAsk<PlacesSearchState>("places:search:state", macSearch());

/** A video editor on this Mac (apps/mac Editors.swift): work-prefs' editor id, the app's name and version. */
export type MacEditor = { id: string; name: string; version: string | null };

/** The video editors this Mac has, for a draft's Open in <editor>: none in a browser or an older Mac app. */
export async function editorsOnMac(): Promise<MacEditor[]> {
  const r = (await thisMacBridge()?.postMessage("editors").catch(() => null)) as unknown as { editors?: MacEditor[] } | null;
  return Array.isArray(r?.editors) ? r.editors : [];
}

/** Opens an AI Editor draft in that editor on this Mac, starting the editor when it is closed. The Mac app fetches the
 *  draft from this server itself. `note`: what the person does next in the editor (an editor that takes no scripts). */
export async function openInEditor(ask: { edit: string; draft: string; editor: string; name: string; project: string; fps: number; width: number; height: number }): Promise<{ ok?: boolean; note?: string; problem?: string }> {
  const bridge = thisMacBridge();
  if (!bridge) return { problem: "Needs the Mac app" };
  const r = (await bridge.postMessage(`open-editor:${JSON.stringify(ask)}`).catch(() => null)) as unknown as { ok?: boolean; note?: string; problem?: string } | null;
  return r ?? { problem: "Could not open the draft" };
}

/**
 * Storage › This computer: the Mac app's download cache folder. The app answers each ask with its own JSON (its path, or
 * none when the picker was cancelled); a browser has no bridge and gets null.
 */
async function thisMacCall<T>(ask: string): Promise<T | null> {
  const bridge = thisMacBridge();
  return bridge ? ((await bridge.postMessage(ask).catch(() => null)) as unknown as T | null) : null;
}
export const downloadLocation = () => thisMacCall<{ path: string }>("download:location");
export const chooseDownloadLocation = () => thisMacCall<{ path?: string }>("download:choose");
export const showDownloadLocation = () => thisMacCall<unknown>("download:show");
