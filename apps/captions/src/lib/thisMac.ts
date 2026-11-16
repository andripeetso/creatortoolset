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

/** The server's answer when no Mac of the person's own is on for a call (api/designs.ts fromMac): `device` is the Mac of theirs it can't reach. */
type NoMac = Error & { code?: string; device?: { id: string; name: string } };
const noMac = (e: unknown): e is NoMac => e instanceof Error && (e as NoMac).code === "no_mac";

/**
 * A call that needs a Mac of the person's own (a cut-out, a split). Inside the Mac app, when the server sees no Mac of
 * theirs, it is done on this Mac: `onHere` is told so first ("Ana's Mac Studio is unreachable. Doing it on this Mac.",
 * or this Mac is not connected to this server), this Mac is switched on for it (Settings → Computers, Use this Mac for my AI, which pairs
 * it with this server) and the call is made again once the server sees it. `signal` stops the waiting. In a browser, or
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
    if (!s?.aiOn || !s.paired) throw new Error(s?.problem ? `This Mac could not be switched on for it: ${s.problem}` : e.message);
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
 * The Finder files and folders of the drag just dropped on the window (AppWebView.dragItems): their paths, so a folder is
 * pointed at where it lies instead of uploaded, and a file's reply needn't wait for its upload. undefined in a browser or
 * a Mac app from before it could; [] when none.
 */
export async function droppedOnMac(): Promise<Array<{ path: string; folder: boolean }> | undefined> {
  const bridge = thisMacBridge();
  if (!bridge) return undefined;
  try {
    const r = ((await bridge.postMessage("dropped")) ?? {}) as unknown as { items?: Array<{ path?: unknown; folder?: unknown }> };
    if (!Array.isArray(r.items)) return undefined;
    return r.items.flatMap((x) => (typeof x.path === "string" ? [{ path: x.path, folder: x.folder === true }] : []));
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
    throw new Error("The Creator Toolset Mac app did not answer. Try again.");
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

/** One import ask; throws with the Mac's reason. */
async function importAsk<T>(ask: string): Promise<T> {
  const bridge = thisMacBridge();
  if (!bridge || !macImports()) throw new Error("Needs the latest Mac app");
  let r: Record<string, unknown>;
  try {
    r = ((await bridge.postMessage(ask)) ?? {}) as unknown as Record<string, unknown>;
  } catch {
    throw new Error("The Creator Toolset Mac app did not answer. Try again.");
  }
  if (typeof r.error === "string") throw new Error(r.error);
  return r as T;
}

export type ImportCopied = { copied: { from: string; to: string }[]; failed: { from: string; error: string }[]; stopped?: boolean };
/** Copies each `from` to `to` ("~/" is this Mac's home folder), never over another file; answers when all are done. */
export const importCopy = (id: string, files: { from: string; to: string }[]) =>
  importAsk<ImportCopied>(`import:copy:${JSON.stringify({ id, files })}`).then((r) => ({ copied: r.copied ?? [], failed: r.failed ?? [], stopped: r.stopped }));
export const importProgress = (id: string) => importAsk<{ bytes: number; of: number; file?: string }>(`import:progress:${id}`);
/** Stops a copy; the file it was writing is removed. */
export const importCancel = (id: string) => importAsk<unknown>(`import:cancel:${id}`);
/** The media files under a place on this Mac (one the person dropped or picked before). */
export const importScan = (path: string) =>
  importAsk<{ files?: { path: string; size: number; mtime: number }[] }>(`import:scan:${JSON.stringify({ path })}`).then((r) => r.files ?? []);
/** Each path's fingerprint, the one lib/onMac.ts quickPrint makes from the file. */
export const importPrint = (paths: string[]) =>
  importAsk<{ prints?: Record<string, string> }>(`import:print:${JSON.stringify({ paths })}`).then((r) => r.prints ?? {});

/** The address the page reads a file on this Mac by (the Mac app's media scheme): the path, base64url. */
export const macMediaUrl = (path: string) =>
  `ctlocal://media/${btoa(String.fromCharCode(...new TextEncoder().encode(path))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
