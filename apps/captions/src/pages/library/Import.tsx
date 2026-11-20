import { useEffect, useState } from "react";
import type { LibrarySummary } from "@contracts/library";
import { folderName } from "@/components/LibraryProcessing";
import { EVERY_WORKSPACE, importTarget, underFolder, type StorageFolder, type StorageView } from "@contracts/storage";
import { PLACES_MAX } from "@contracts/places";
import { Button } from "@/components/ui/button";
import { checkUpload, reportPlaces, versionPlaces } from "@/lib/library";
import { allGranted, folderGrant, listMediaFolders } from "@/lib/local-files";
import { indexOnMac, quickPrint } from "@/lib/onMac";
import { thisMacDevice } from "@/lib/providers";
import { importCopy, importPrint, importScan, macImports, macMediaUrl, NOT_A_COPY_FOLDER, pathOnMac, thisMacBridge } from "@/lib/thisMac";
import { WORDS } from "@/lib/wording";

/**
 * How files come into the Media Library: the one import rule (contracts/storage.ts importTarget), no question. A file
 * inside a Media folder on this computer is indexed where it is; one from outside, a loose file or a dropped folder's,
 * is copied once into the first Media folder's Imports/ (copyInto), then indexed in place from there.
 */

/**
 * Where files are added from: the Mac app with the server elsewhere ("mac": read on this Mac, nothing uploads unless
 * the upload setting says so), the server on this computer ("here": its files are read where they are or copied
 * there), or a browser with the server elsewhere ("browser": files upload).
 */
export type AddFrom = "mac" | "here" | "browser";
export const addFrom = (serverHere: boolean | undefined): AddFrom => (!thisMacBridge() ? "browser" : serverHere ? "here" : "mac");

/** Copying loose files needs the Mac app's import asks; a folder on the server's own computer is copied by the server. */
export const copyAvailable = (from: AddFrom, serverCopies = false) => (from === "here" && serverCopies) || (from !== "browser" && macImports());

/** Where a copy of a dropped file goes: under `dir` (importTarget), with its folder's name (webkitRelativePath) or its own. */
export const copyInto = (dir: string, file: File): string => `${dir.replace(/\/+$/, "")}/${file.webkitRelativePath || file.name}`;

/** The Source media folders on this computer: the workspace's own first, then one every workspace uses (as a save on a
 *  computer picks, api/library/routes.ts saveOnComputer), each in the order the folder list has them. */
export async function sourceRowsHere(): Promise<string[]> {
  const me = thisMacDevice();
  const r = me ? await fetch("/api/devices/storage").catch(() => null) : null;
  const view = r?.ok ? ((await r.json()) as StorageView) : null;
  const here = (view?.folders ?? []).filter((f) => f.role === "footage" && f.origin.host === me);
  return [...here].sort((a, b) => Number(a.workspace === EVERY_WORKSPACE) - Number(b.workspace === EVERY_WORKSPACE)).map((f) => f.origin.path);
}

/**
 * Where one file added from this Mac is read from, by the import rule (an edit's footage, EditorPage): its own place when
 * it is inside a Media folder here, else a copy made once in the first Media folder's Imports/<name>/. Undefined: no copy
 * to read (a browser, an older Mac app, or a file the library has already, which is never copied again). Throws when a
 * file from outside has no Media folder to go to, or the copy fails (its drive isn't connected).
 */
export async function importPlace(libraryId: string, file: File, name?: string): Promise<string | undefined> {
  const at = macImports() ? await pathOnMac(file) : undefined;
  if (!at) return undefined;
  const rows = await sourceRowsHere();
  if (rows.some((r) => underFolder(at, r))) return at;
  if ((await checkUpload(libraryId, file.size, `mac:${await quickPrint(file)}`).catch(() => null))?.duplicateOf) return undefined;
  const dir = importTarget(rows, name);
  if (!dir) throw new Error("Add a Media folder in Settings → Folders");
  const r = await importCopy(`copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, [{ from: at, to: copyInto(dir, file) }]);
  // shortcut: a Mac app that doesn't copy into Imports/ yet uses the file where it is, as an older app does; gone once every Mac has the release
  if (!r.copied[0] && r.failed[0]?.error === NOT_A_COPY_FOLDER) return at;
  if (!r.copied[0]) throw new Error(r.failed[0]?.error ?? "Could not copy the file");
  return r.copied[0].to;
}

/**
 * A dropped folder that holds a Media folder of this computer that isn't this workspace's own: the line refusing the
 * drop (the same as the AI Editor's, apps/editor worker.py import_outside), else null. Its files would be another
 * library's footage copied into this one. shortcut: by path, not real path (the page can't resolve links); the Mac app checks real paths on each copy.
 */
export async function holdsMediaFolder(folders: string[]): Promise<string | null> {
  const me = thisMacDevice();
  // no device id: nothing says which folders are on this Mac (the Mac app checks each copy itself)
  if (!folders.length || !me) return null;
  const r = await fetch("/api/devices/storage?all=1").catch(() => null);
  const view = r?.ok ? ((await r.json()) as StorageView) : null;
  const own = new Set(await sourceRowsHere());
  // another workspace's Media folder in it: its files would be that library's footage
  const media = (view?.folders ?? []).filter((f) => f.role === "footage" && f.origin.host === me && !own.has(f.origin.path)).map((f) => f.origin.path);
  for (const p of folders) {
    const inside = media.find((m) => underFolder(m, p));
    if (inside) return `${p} holds the Media folder ${inside}: drop the folder with the footage itself`;
  }
  return null;
}

/** Runs `fn` on each item, `n` at a time. */
async function each<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

type Known = { versionId: string; path: string; quick: string };

/**
 * Files the library has, found by Look for new files at a path this computer doesn't read them from: each becomes this
 * computer's way to its clip (api/library/places.ts confirmPlaces; a file moved on its share moves for everybody). One
 * this computer reads at a path seen in the same look is a second copy, and stays as it is. How many reconnected.
 */
export async function reconnectKnown(libraryId: string, known: Known[], seen: Set<string>): Promise<number> {
  const device = thisMacDevice();
  if (!device || !known.length) return 0;
  const ids = [...new Set(known.map((k) => k.versionId))];
  const tries: Record<string, string[]> = {};
  for (let i = 0; i < ids.length; i += PLACES_MAX) {
    const r = await versionPlaces(libraryId, device, ids.slice(i, i + PLACES_MAX));
    for (const [id, v] of Object.entries(r.versions)) tries[id] = v.tries.map((t) => t.normalize("NFC"));
  }
  const post = new Map<string, Known>();
  for (const k of known) {
    const t = tries[k.versionId];
    // not a clip the caller may see, posted already, or read here already
    if (!t || post.has(k.versionId) || t.includes(k.path.normalize("NFC")) || t.some((p) => seen.has(p))) continue;
    post.set(k.versionId, k);
  }
  const list = [...post.values()];
  let n = 0;
  for (let i = 0; i < list.length; i += PLACES_MAX) n += (await reportPlaces(libraryId, { device, confirmed: list.slice(i, i + PLACES_MAX), gone: [] })).confirmed.length;
  return n;
}

/**
 * Look for new files, from the Mac app with the server elsewhere: each Source media folder on this computer is read again,
 * the files the library has already (by their fingerprint) are left out, and each new one is indexed where it is, read by
 * its address. One the library has at a path this computer doesn't know is reconnected (reconnectKnown). `onStep` hears how
 * far it is. A folder the Mac app may not read (no drop or pick granted it) is read through its granted folders inside it,
 * and named in `refused` for an Allow press. Resolves to the numbers added and reconnected, and those folders.
 * ponytail: one check per file found; a batch check on the server when folders hold many thousands of files.
 */
export async function lookForNew(library: LibrarySummary, onStep: (line: string) => void, signal?: AbortSignal): Promise<{ added: number; reconnected: number; refused: string[] }> {
  let added = 0;
  const known: Known[] = [];
  const seen = new Set<string>();
  const refused: string[] = [];
  for (const place of await sourceRowsHere()) {
    onStep(`Looking in ${folderName(place)}`);
    let files: Awaited<ReturnType<typeof importScan>>;
    try {
      files = await importScan(place);
    } catch (e) {
      const granted = await listMediaFolders();
      if (allGranted([place], granted)) throw e; // granted: its disk away or the like, said as before
      refused.push(place);
      const inside = granted.filter((g) => allGranted([g], [place]));
      files = (await Promise.all(inside.map((g) => importScan(g).catch(() => [])))).flat();
    }
    for (const f of files) seen.add(f.path.normalize("NFC"));
    const prints: Record<string, string> = {};
    for (let i = 0; i < files.length; i += 500) Object.assign(prints, await importPrint(files.slice(i, i + 500).map((f) => f.path)));
    const fresh: typeof files = [];
    await each(files, 8, async (f) => {
      const quick = prints[f.path];
      if (!quick) return;
      const there = await checkUpload(library.id, f.size, `mac:${quick}`, quick).catch(() => ({ duplicateOf: "?", versionId: undefined }));
      if (!there.duplicateOf) fresh.push(f);
      else if (there.versionId) known.push({ versionId: there.versionId, path: f.path, quick });
    });
    for (const f of fresh) {
      signal?.throwIfAborted();
      onStep(`Adding ${added + 1} of ${fresh.length} from ${folderName(place)}`);
      const name = f.path.split("/").pop() ?? f.path;
      const r = await indexOnMac(library.id, { url: macMediaUrl(f.path), name, size: f.size, quick: prints[f.path]! }, f.path, undefined, signal, !!library.settings.blurFaces).catch(() => ({}));
      if ("assetId" in r && r.assetId) added++;
    }
  }
  signal?.throwIfAborted();
  const reconnected = await reconnectKnown(library.id, known, seen).catch(() => 0);
  return { added, reconnected, refused };
}

/** "Creator Toolset can't read MOO" with its Allow button: folders this Mac may not read yet. Opens nothing by itself. */
export function CantRead({ folders, onAllow, busy }: { folders: string[]; onAllow: () => void; busy?: boolean }) {
  if (!folders.length) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      <span>Creator Toolset can't read {folders.map(folderName).join(", ")}</span>
      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={onAllow}>
        {WORDS.allowOnThisMac}
      </Button>
    </p>
  );
}

/** This Mac's Settings → Folders folders (the window's workspace's) that wait for its OK: their location agent reads nothing there yet. */
export const waitingFolders = (view: Pick<StorageView, "folders"> | null, me: string | undefined) =>
  me ? (view?.folders ?? []).filter((f) => f.origin.host === me && f.folderState === "needs_ok") : [];

/**
 * On the Library page in the Mac app: the folders of this Mac that wait for an OK, one quiet line. Allow is the same
 * press as Settings → Folders' (folderGrant); the Mac's location agent then reads the folder and connects the clips
 * uploaded from it to their files here.
 */
export function FoldersToAllow() {
  const [waiting, setWaiting] = useState<StorageFolder[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const me = thisMacDevice();
    if (!me) return;
    let live = true;
    void fetch("/api/devices/storage")
      .then((r) => (r.ok ? (r.json() as Promise<StorageView>) : null))
      .then((v) => live && setWaiting(waitingFolders(v, me)), () => undefined);
    return () => void (live = false);
  }, []);
  const allow = async () => {
    setBusy(true);
    const left: StorageFolder[] = [];
    for (const f of waiting) if (!(await folderGrant(f.origin.path, f.id))) left.push(f);
    setWaiting(left);
    setBusy(false);
  };
  return <CantRead folders={waiting.map((f) => f.origin.path)} onAllow={() => void allow()} busy={busy} />;
}

/** What Look for new files did, in one line: "Added 3 · reconnected 12", or "No new files"; `coming`: new files still being copied in ("2 coming in"). */
export const lookedLine = (added: number, reconnected: number, coming = 0) =>
  coming ? [added ? `Added ${added.toLocaleString()}` : "", `${coming.toLocaleString()} coming in`].filter(Boolean).join(" · ") : lookedOnly(added, reconnected);
const lookedOnly = (added: number, reconnected: number) =>
  [added ? `Added ${added.toLocaleString()}` : "", reconnected ? `${added ? "reconnected" : "Reconnected"} ${reconnected.toLocaleString()}` : ""].filter(Boolean).join(" · ") ||
  "No new files";

/** What one add works out before it goes in: where the files are on this computer (a Finder drop says, picked files are asked of the Mac app). */
export interface ImportLook {
  from: AddFrom;
  /** where each file is on this computer */
  paths?: Map<File, string>;
}

/**
 * The import rule applied to an add (LibraryPage addFiles), with no question. `prepare` finds where the files are;
 * `answer` resolves to where each copy goes: none for a file inside a Media folder here or a browser's upload, each
 * file from outside under the first Media folder's Imports/<the day>/, or null when there is no Media folder on this
 * computer (the add is refused, `onError` says so). A file the library has already is never copied (import-queue.ts).
 */
export function useImportQuestion({ serverHere, onError }: { serverHere: boolean; onError: (e: string) => void }) {
  const prepare = async (files: File[], paths?: Map<File, string>): Promise<ImportLook> => {
    const from = addFrom(serverHere);
    let known = paths;
    if (!known && from !== "browser") {
      const found = await Promise.all(files.map((f) => pathOnMac(f)));
      known = new Map(files.flatMap((f, i) => (found[i] ? [[f, found[i]!] as const] : [])));
    }
    if (known && !known.size) known = undefined;
    return { from, paths: known };
  };

  const answer = async (look: ImportLook, files: File[]): Promise<Map<File, string> | null> => {
    if (look.from === "browser" || !look.paths) return new Map();
    const rows = await sourceRowsHere();
    const want = files.filter((f) => {
      const at = look.paths!.get(f);
      return at && !rows.some((r) => underFolder(at, r));
    });
    // shortcut: an older Mac app can't copy, so a file from outside is indexed where it is, as before; gone once every Mac has 0.19
    if (!want.length || !copyAvailable(look.from)) return new Map();
    const dir = importTarget(rows);
    if (!dir) {
      onError("Add a Media folder in Settings → Folders");
      return null;
    }
    return new Map(want.map((f) => [f, copyInto(dir, f)]));
  };

  return { prepare, answer };
}
