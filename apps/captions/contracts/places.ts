/**
 * Here or away: where a clip's original is, for each computer.
 *
 * A version's original lives on a root (a network share, or a volume: named the same on every computer, `rootKey`) at a
 * root path inside it ("2025/June/C0012.MP4", "/"-separated, no leading "/"). Each computer reaches the root at its own
 * mount path, so its path to the file is `joinRoot(disk.path, rootRel)`. A copy only one computer has (a laptop's own
 * disk) is that computer's place. The server lists the paths to try on a computer (best first); the computer that reads
 * the disk says what is there.
 *
 * The Mac app: `<html data-mac-places="1">` when it answers the places asks below ("2": Find missing files too), and
 * `window.dispatchEvent(new CustomEvent("mac-places", { detail: { at } }))` whenever a disk is connected, goes away or
 * comes back (every answer cached before it is stale).
 */
import type { ShareFs } from "./storage";

/** The most versions in one places ask or GET …/places. */
export const PLACES_MAX = 200;

// ---- Roots and paths (pure; the Mac app has the same in Swift, with the same test rows: places.test.ts) ----

/** A Windows path ("Z:\…", "\\server\share\…"). */
export const isWindowsPath = (p: string) => /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");

/**
 * A disk's root key, the same from every computer that has it: a share is `${fs}://${host}/${share}` (host in lower case
 * without ".local", a Bonjour service name or a trailing dot; an SMB or AFP share's name in lower case, an NFS export as
 * it is; slashes trimmed), a volume is `vol:${UUID}`. Text is NFC. Undefined for a disk that says neither.
 */
export function rootKey(d: { fs?: ShareFs; server?: string; share?: string; uuid?: string }): string | undefined {
  if (d.fs && d.server && d.share) {
    const host = d.server.normalize("NFC").toLowerCase().replace(/\.$/, "").replace(/(\._[a-z0-9-]+\._tcp)?\.local$/, "");
    const name = d.share.normalize("NFC").replace(/^\/+|\/+$/g, "");
    return `${d.fs}://${host}/${d.fs === "nfs" ? name : name.toLowerCase()}`;
  }
  return d.uuid ? `vol:${d.uuid.toUpperCase()}` : undefined;
}

/** `rel` ("/"-separated) inside the folder `dir`, written with dir's own separator: a root path on one computer. */
export function joinRoot(dir: string, rel: string): string {
  const rest = rel.replace(/^\/+/, "");
  if (!rest) return dir;
  const sep = isWindowsPath(dir) ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${rest.split("/").join(sep)}`;
}

/** A folder change: what started with `from` now starts with `to`. */
export interface PathMove {
  from: string;
  to: string;
}

const isSep = (c: string) => c === "/" || c === "\\";

/**
 * The folder change that took `oldPath` to `newPath`: the end both share, from a separator, dropped
 * ("2025/a.mov" → "Archive/2025/a.mov" is 2025 → Archive/2025). Null when the file's own name changed, the paths are the
 * same, or the shared end has no folder in it ("a.mov" → "2025/a.mov": pass whole paths to catch a move at the top).
 * "/" and "\" are one separator; text is compared and given back in NFC.
 */
export function derivedMove(oldPath: string, newPath: string): PathMove | null {
  const a = oldPath.normalize("NFC");
  const b = newPath.normalize("NFC");
  let k = 0;
  while (k < Math.min(a.length, b.length)) {
    const x = a[a.length - 1 - k];
    const y = b[b.length - 1 - k];
    if (x !== y && !(isSep(x) && isSep(y))) break;
    k++;
  }
  const cut = a.slice(a.length - k).search(/[\\/]/);
  if (cut < 0) return null;
  const from = a.slice(0, a.length - k + cut);
  const to = b.slice(0, b.length - k + cut);
  return from === to ? null : { from, to };
}

/** `path` after the folder change (written with the new folder's separator, NFC); null when it isn't inside `from`. */
export function applyMove(path: string, m: PathMove): string | null {
  const p = path.normalize("NFC").replace(/\\/g, "/");
  const f = m.from.normalize("NFC").replace(/\\/g, "/");
  if (p !== f && !p.startsWith(f.endsWith("/") ? f : `${f}/`)) return null;
  return joinRoot(m.to, p.slice(f.length));
}

// ---- The server's places routes (api/library/places.ts) ----

/** A root as people read it: the share's name and its server ("footage" on "office-nas"), or a volume's name. */
export interface RootLabel {
  key: string;
  name: string;
  server?: string;
}

/** GET /api/library/:lib/places?device=<computer id>&versions=<id>,<id>… (at most PLACES_MAX; the caller's own computer). */
export interface VersionPlaces {
  /** paths to look at on that computer, best first */
  tries: string[];
  bytes: number;
  /** the quick fingerprint (api/work/files.ts quickPrint); null when the version has none yet */
  quick: string | null;
  /** the root the original is on, when known */
  root?: RootLabel;
  /** the server's proxy, when one is stored */
  proxy: { bytes: number } | null;
  /** the proxy is in that computer's proxy cache */
  cached?: true;
}
/** Versions the caller may not read, or that don't exist, are left out. */
export interface PlacesAnswer {
  versions: Record<string, VersionPlaces>;
}

/** POST /api/library/:lib/places: what a computer of the caller's found where it looked. */
export interface PlacesReport {
  device: string;
  /** read there (size equal); `quick` when it was read */
  confirmed: { versionId: string; path: string; quick?: string }[];
  /** version ids not at any try, the root reachable */
  gone: string[];
}
export interface PlacesReportAnswer {
  /** version ids of the confirmed entries taken */
  confirmed: string[];
  /** version ids of the confirmed entries refused: another file (a different fingerprint), or not the caller's to read */
  refused: string[];
}

/** GET /api/library/:lib/places/gone?device=<computer id>[&away=1]: what that computer last found gone and can search for;
 *  `away=1` also the versions whose root isn't connected there. */
export interface GoneVersion {
  versionId: string;
  bytes: number;
  /** only versions with a quick fingerprint are listed */
  quick: string;
  /** the root key and root path it was at; null when not known */
  root: string | null;
  rootRel: string | null;
  /** where that computer last looked; "" when it never had a path for it */
  path: string;
  /** the file's name */
  name: string;
}
export interface GoneAnswer {
  gone: GoneVersion[];
}

/** GET /api/library/:lib/places/moves: the last reconnects (at most 50 per library), newest first, one per folder change. */
export interface PlaceMove {
  at: number;
  /** moved: on its own root, for everybody ("Moved: 2025 → Archive/2025"); found: copies on another disk, for the
   *  computer that found them ("Found on Travel SSD") */
  kind: "moved" | "found";
  /** the folder change (derivedMove): root paths when moved, paths on that computer when found */
  from: string;
  to: string;
  count: number;
  /** moved: the root; found: the disk the copies are on */
  root?: RootLabel;
}
export interface MovesAnswer {
  moves: PlaceMove[];
}

// ---- The Mac app's places asks (through the import handler, apps/mac Import.swift) ----

/** What a computer found for one version's original. A page without the Mac app has none: it plays the server's proxy. */
export type HereState = "here" | "away" | "gone" | "cached";

/** `places:check:<PlacesCheckAsk>` → PlacesCheckAnswer. The Mac gets the tries itself (GET …/places), never a path from the page. */
export interface PlacesCheckAsk {
  library: string;
  /** at most PLACES_MAX */
  versions: string[];
}
export type PlaceCheck = (
  /** read here; `url` plays it (ctlocal://media/…) */
  | { state: "here"; path: string; url: string; needs?: never }
  /** read here, outside the folders the page may play from: the access button opens the folder panel at `folder` */
  | { state: "here"; path: string; needs: "access"; folder: string; root?: RootLabel; url?: never }
  /** its disk isn't reachable or not connected here; `needs: "connect"` when the server answers but the share
   *  isn't mounted (the Connect button) */
  | { state: "away"; root?: RootLabel; needs?: "connect" }
  /** the disk is reachable, and no try has the file */
  | { state: "gone" }
) & {
  /** this computer's proxy cache has the proxy (Available offline): it plays from here (ctlocal://media/…) before the
   *  server's when the original doesn't */
  cached?: string;
}
  /** nothing else known here (no original on a computer, or the server not answering), and the proxy cache has it */
  | { state: "cached"; url: string; cached?: never };
export interface PlacesCheckAnswer {
  versions: Record<string, PlaceCheck>;
}

/** `places:connect:<PlacesConnectAsk>`: connect that share, the login panel allowed (pressed Connect only). */
export interface PlacesConnectAsk {
  /** rootKey of the share */
  root: string;
}
export type PlacesConnectAnswer = { ok: true } | { problem: string };

/** `places:search:<PlacesSearchAsk>` starts Find missing files (one at a time on a Mac); `places:search:state` reads it.
 *  Both answer PlacesSearchState. */
export interface PlacesSearchAsk {
  library: string;
}
export interface PlacesSearchState {
  /** the library of the last search ("" before the first) */
  library: string;
  running: boolean;
  /** entries listed so far */
  looked: number;
  found: number;
  /** gone versions not found yet */
  left: number;
  /** folders holding files that may be gone ones, outside the folders the page may play from: none of them was read,
   *  and the server heard nothing of them. Allow access (askMediaFolder), then search again. */
  access: string[];
}
