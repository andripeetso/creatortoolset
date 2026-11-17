import { useState, type ReactNode } from "react";
import { placeOf, type ImportMode, type LibrarySettings, type LibrarySummary, type LibraryUpload } from "@contracts/library";
import { CopyTo, folderName } from "@/components/LibraryProcessing";
import { SettingsSelect } from "@/components/settings/ui";
import { PLACES_MAX } from "@contracts/places";
import { checkUpload, reportPlaces, updateLibrary, versionPlaces } from "@/lib/library";
import { indexOnMac } from "@/lib/onMac";
import { thisMacDevice } from "@/lib/providers";
import { chooseFolderOnMac, importPrint, importScan, macImports, macMediaUrl, pathOnMac, thisMacBridge } from "@/lib/thisMac";
import { UPLOAD_LABEL, UPLOAD_OPTIONS } from "./UploadSelect";

/**
 * How files come into the Media Library (settings.importMode, places): used where they are, or copied into the
 * library's folder first. The first add asks (with the organize question and, from the Mac app with the server
 * elsewhere, the upload choice) in the one dialog of LibraryPage / useBigFolder; an add from a place the library knows
 * is not asked again, one from a new place is asked in short, defaulting to the library's answer, and remembered.
 */

/**
 * Where files are added from: the Mac app with the server elsewhere ("mac": read on this Mac, nothing uploads unless
 * the upload setting says so), the server on this computer ("here": its files are read where they are or copied
 * there), or a browser with the server elsewhere ("browser": files upload).
 */
export type AddFrom = "mac" | "here" | "browser";
export const addFrom = (serverHere: boolean | undefined): AddFrom => (!thisMacBridge() ? "browser" : serverHere ? "here" : "mac");

/** What adding from `places` asks: the whole question, the short one for a new place, the browser's one line, or nothing. */
export type ImportAsk = { kind: "first" } | { kind: "new"; mode: ImportMode } | { kind: "upload" } | null;
export function importAsk(from: AddFrom, s: Pick<LibrarySettings, "importMode" | "places">, places: string[]): ImportAsk {
  if (from === "browser") return { kind: "upload" };
  if (!s.importMode) return { kind: "first" };
  return places.some((p) => !placeOf(s.places, p)) ? { kind: "new", mode: s.importMode } : null;
}

/** Copying loose files needs the Mac app's import asks; a folder on the server's own computer is copied by the server. */
export const copyAvailable = (from: AddFrom, serverCopies = false) => (from === "here" && serverCopies) || (from !== "browser" && macImports());
export const NEEDS_MAC = "Needs the latest Mac app";

/** The place a file came from: the dropped folder it was read from, else the folder it is in. */
export function placeOfFile(file: File, path: string): string {
  const rel = (file.webkitRelativePath || "").normalize("NFC");
  if (rel.includes("/") && path.endsWith(rel)) return path.slice(0, path.length - rel.length) + rel.split("/")[0];
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

const AUDIO = /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i;
const PICTURE = /\.(jpe?g|png|heic|webp|gif|tiff?)$/i;

/** The library's folder on this Mac: the one chosen, else ~/Movies/Creator Toolset/<library>. */
export const copyRoot = (library: Pick<LibrarySummary, "name" | "settings">) => library.settings.copyTo ?? `~/Movies/Creator Toolset/${library.name}`;

/** Where the copy of `path` (from `place`) goes: <root>/<Footage|Audio|Pictures>/<the place's name>/<its path in the place>. */
export function copyPath(root: string, place: string, path: string): string {
  const kind = AUDIO.test(path) ? "Audio" : PICTURE.test(path) ? "Pictures" : "Footage";
  return `${root.replace(/\/+$/, "")}/${kind}/${folderName(place)}/${path.slice(place.replace(/\/+$/, "").length + 1)}`;
}

// saves on their way, per library: folders dropped together are kept one after another, each on the one saved before
const saving = new Map<string, Promise<LibrarySummary | null>>();

/** The answer kept: the library's mode the first time, each new place with the mode chosen, and what else was asked with it. */
export function rememberImport(library: LibrarySummary, mode: ImportMode, places: string[], extra: Partial<LibrarySettings> = {}): Promise<LibrarySummary> {
  const next = (saving.get(library.id) ?? Promise.resolve(null)).catch(() => null).then((before) => {
    const s = (before ?? library).settings;
    const known = s.places ?? [];
    const fresh = [...new Set(places)].filter((p) => !placeOf(known, p));
    return updateLibrary(library.id, {
      settings: {
        ...(s.importMode ? {} : { importMode: mode }),
        ...(fresh.length ? { places: [...known, ...fresh.map((path) => ({ path, mode }))] } : {}),
        ...extra,
      },
    });
  });
  saving.set(library.id, next);
  void next.catch(() => null).finally(() => saving.get(library.id) === next && saving.delete(library.id));
  return next;
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
 * Look for new files, from the Mac app with the server elsewhere: each place used where it is is read again on this
 * Mac, the files the library has already (by their fingerprint) are left out, and each new one is indexed where it is,
 * read by its address. One the library has at a path this computer doesn't know is reconnected (reconnectKnown). `onStep`
 * hears how far it is. Resolves to the numbers added and reconnected.
 * ponytail: one check per file found; a batch check on the server when places hold many thousands of files.
 */
export async function lookForNew(library: LibrarySummary, onStep: (line: string) => void, signal?: AbortSignal): Promise<{ added: number; reconnected: number }> {
  let added = 0;
  const known: Known[] = [];
  const seen = new Set<string>();
  for (const place of (library.settings.places ?? []).filter((p) => p.mode === "in-place")) {
    onStep(`Looking in ${folderName(place.path)}`);
    const files = await importScan(place.path);
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
      onStep(`Adding ${added + 1} of ${fresh.length} from ${folderName(place.path)}`);
      const name = f.path.split("/").pop() ?? f.path;
      const r = await indexOnMac(library.id, { url: macMediaUrl(f.path), name, size: f.size, quick: prints[f.path]! }, f.path, undefined, signal).catch(() => ({}));
      if ("assetId" in r && r.assetId) added++;
    }
  }
  signal?.throwIfAborted();
  const reconnected = await reconnectKnown(library.id, known, seen).catch(() => 0);
  return { added, reconnected };
}

/** What Look for new files did, in one line: "Added 3 · reconnected 12", or "No new files". */
export const lookedLine = (added: number, reconnected: number) =>
  [added ? `Added ${added.toLocaleString()}` : "", reconnected ? `${added ? "reconnected" : "Reconnected"} ${reconnected.toLocaleString()}` : ""].filter(Boolean).join(" · ") ||
  "No new files";

/** The two ways in, as words. */
export const IMPORT_MODES: { value: ImportMode; label: string; detail: string }[] = [
  { value: "in-place", label: "Keep in place", detail: "Files are read where they are." },
  { value: "copy", label: "Copy into the library", detail: "Files are copied into the library's Footage, Audio and Pictures folders." },
];

/**
 * The two ways in as radio cards, for the add dialog. `copy.to`: where copies go (the path with Change); `copy.off`: why
 * copying can't be chosen here. `short`: a new place's question, the labels only.
 */
export function ImportCards({ legend, value, onChange, copy, short = false }: { legend: string; value: ImportMode; onChange: (m: ImportMode) => void; copy: { to: ReactNode; off?: string }; short?: boolean }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      {IMPORT_MODES.map((o) => {
        const off = o.value === "copy" ? copy.off : undefined;
        return (
          <label key={o.value} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-zinc-500/20 px-3 py-2.5 has-[:checked]:border-violet-500/60 has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
            <input type="radio" name="import-mode" className="mt-1 accent-violet-500" checked={value === o.value} disabled={!!off} onChange={() => onChange(o.value)} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">{o.label}</span>
              {o.value === "copy" && copy.to}
              {off ? <span className="text-xs text-zinc-500">{off}</span> : !short && <span className="text-xs text-zinc-500">{o.detail}</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** What one add asks, worked out before its dialog: where the files are, their places, the question. */
export interface ImportLook {
  from: AddFrom;
  ask: ImportAsk;
  places: string[];
  /** where each file is on this computer (a Finder drop says; picked files are asked of the Mac app) */
  paths?: Map<File, string>;
}

/** Where each file's copy goes: the files from a place kept as copied (`chosen`: a new place's answer). */
export function copiesOf(library: LibrarySummary, files: File[], paths: Map<File, string> | undefined, chosen?: ImportMode): Map<File, string> {
  const out = new Map<File, string>();
  for (const f of files) {
    const path = paths?.get(f);
    if (!path) continue;
    const place = placeOfFile(f, path);
    if ((placeOf(library.settings.places, place)?.mode ?? chosen) === "copy") out.set(f, copyPath(copyRoot(library), place, path));
  }
  return out;
}

/**
 * The import question of the Media Library page's add (LibraryPage addFiles): `look` works out what an add asks,
 * `body` is the question for its dialog (BigUploadDialog), and `answer` keeps the answer and says where each file's copy
 * goes. `owner`: only the library's owner is asked; anyone else's files go in as before.
 */
export function useImportQuestion({ library, serverHere, owner, onSaved, onError }: { library: LibrarySummary | null; serverHere: boolean; owner: boolean; onSaved: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const [look, setLook] = useState<ImportLook | null>(null);
  const [mode, setMode] = useState<ImportMode>("in-place");
  const [upload, setUpload] = useState<LibraryUpload>("none");
  const [root, setRoot] = useState<string | undefined>();

  const prepare = async (files: File[], paths?: Map<File, string>): Promise<ImportLook> => {
    const from = addFrom(serverHere);
    let known = paths;
    if (!known && from !== "browser") {
      const found = await Promise.all(files.map((f) => pathOnMac(f)));
      known = new Map(files.flatMap((f, i) => (found[i] ? [[f, found[i]!] as const] : [])));
    }
    if (known && !known.size) known = undefined;
    const places = [...new Set(files.flatMap((f) => (known?.get(f) ? [placeOfFile(f, known.get(f)!)] : [])))];
    // files with no known place go in as they always did (an upload)
    const ask = !owner || !library || (from !== "browser" && !places.length) ? null : importAsk(from, library.settings, places);
    const l: ImportLook = { from, ask, places, paths: known };
    setLook(l);
    setMode(ask?.kind === "new" ? ask.mode : "in-place");
    setUpload(library?.settings.upload ?? "none");
    setRoot(undefined);
    return l;
  };

  /** Keeps the answer (when it was asked) and resolves to the library as saved and where each copy goes. */
  const answer = async (l: ImportLook, files: File[]): Promise<{ library: LibrarySummary | null; copies: Map<File, string> }> => {
    if (!library) return { library, copies: new Map() };
    const asked = l.ask && l.ask.kind !== "upload";
    let saved = library;
    if (asked) {
      saved = await rememberImport(library, mode, l.places, { ...(l.ask?.kind === "first" && l.from === "mac" ? { upload } : {}), ...(root ? { copyTo: root } : {}) }).then(
        (s) => (onSaved(s), s),
        (e: unknown) => (onError(e instanceof Error ? e.message : String(e)), library),
      );
    }
    return { library: saved, copies: copiesOf(saved, files, l.paths, asked ? mode : undefined) };
  };

  const ask = look?.ask;
  const copyOk = !!look && copyAvailable(look.from);
  const fresh = look && library ? look.places.filter((p) => !placeOf(library.settings.places, p)) : [];
  const body =
    !ask || !library || ask.kind === "upload" ? null : (
      <>
        <ImportCards
          legend={ask.kind === "first" ? "Import" : `Files from ${fresh.map(folderName).join(", ")}`}
          short={ask.kind === "new"}
          value={mode}
          onChange={setMode}
          copy={{
            to: copyOk ? <CopyTo path={root ?? copyRoot(library)} onChange={() => void chooseFolderOnMac().then((p) => p && setRoot(p))} /> : null,
            off: copyOk ? undefined : NEEDS_MAC,
          }}
        />
        {ask.kind === "first" && look?.from === "mac" && (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">{UPLOAD_LABEL}</span>
            <SettingsSelect label={UPLOAD_LABEL} value={upload} options={UPLOAD_OPTIONS} onValueChange={(v) => setUpload(v as LibraryUpload)} />
          </div>
        )}
      </>
    );
  return { prepare, answer, body };
}
