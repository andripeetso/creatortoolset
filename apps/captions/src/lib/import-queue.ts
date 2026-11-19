import { create } from "zustand";
import { audioOf, checkUpload, getEstimate, uploadFile } from "@/lib/library";
import { quickPrint } from "@/lib/onMac";
import { importCancel, importCopy, importProgress, pathOnMac } from "@/lib/thisMac";
import { going } from "@/pages/library/Placeholders";
import { alreadyThere, type Upload } from "@/pages/library/Uploads";
import { importGates, volumeOf } from "@/pages/library/import-pool";

/**
 * The Media Library's imports, for the whole app (11-19: they lived in the Library page, so leaving it lost the cards and
 * the line while the files kept going). A drop's files go in side by side, each stage bounded (pages/library/import-pool.ts);
 * the Library page draws their cards and the line from here, and coming back shows them as they are; the top bar says an
 * import is going anywhere else (components/ImportIndicator.tsx). Nothing here is kept over a reload of the window.
 */

export interface QueueItem extends Upload {
  libraryId: string;
  /** indexed where it is on this Mac (the Mac app, a server elsewhere, uploading off), never uploaded */
  mac: boolean;
}

interface Queue {
  items: QueueItem[];
  /** when the current batch began (nothing was going before it): the pace of the line */
  startedAt: number;
  /** the batch's estimate in dollars; null when none was asked (Effort Off) or it hasn't answered */
  usd: number | null;
}

export const useImportQueue = create<Queue>(() => ({ items: [], startedAt: 0, usd: null }));

const gates = importGates();
const controllers = new Map<number, AbortController>();
const cancelled = new Set<number>();
let lastKey = 0;
const landed = new Set<(libraryId: string, folderId?: string) => void>();

/** A file went in: the page showing that library reads its clips (and the folder's count) again. */
export function onImported(fn: (libraryId: string, folderId?: string) => void): () => void {
  landed.add(fn);
  return () => void landed.delete(fn);
}

const patch = (key: number, change: Partial<QueueItem>) =>
  useImportQueue.setState((s) => ({ items: s.items.map((u) => (u.key === key ? { ...u, ...change } : u)) }));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface AddOptions {
  libraryId: string;
  /** the manual folder open when they were dropped: they go in there */
  folderId?: string;
  /** added where they are on this computer (the drop's paths, or the Mac app on its own server) */
  here?: boolean;
  paths?: Map<File, string>;
  /** copied here first (the library's Source media on this Mac) */
  copies?: Map<File, string>;
  mac: boolean;
  /** ask what the batch costs (false at Effort Off: no cost is shown) */
  cost: boolean;
}

/** Starts every file at once; each waits only where its stage is full, and has its card at once. */
export function addImports(files: File[], o: AddOptions): void {
  const added: QueueItem[] = files.map((file) => ({
    key: ++lastKey,
    libraryId: o.libraryId,
    mac: o.mac,
    file,
    sent: 0,
    folderId: o.folderId,
    status: "waiting" as const,
    inPlace: o.paths ? o.paths.has(file) : !!o.here,
    path: o.paths?.get(file),
    copyTo: o.copies?.get(file),
  }));
  useImportQueue.setState((s) => {
    // a new batch (nothing going): the count, the pace and the cost start again
    const fresh = !s.items.some(going);
    return { items: [...s.items.filter((u) => going(u) || u.status === "failed"), ...added], ...(fresh ? { startedAt: Date.now(), usd: null } : {}) };
  });
  if (o.cost)
    void getEstimate(o.libraryId, { clips: files.length, bytes: files.reduce((n, f) => n + f.size, 0), ...audioOf(files) }).then(
      (e) => useImportQueue.setState((s) => ({ usd: (s.usd ?? 0) + e.steps.reduce((n, x) => n + x.usd, 0) })),
      () => {},
    );
  for (const u of added) void send(u);
}

/** Retry: sends a failed or cancelled file again. */
export function retryImport(key: number): void {
  const u = useImportQueue.getState().items.find((x) => x.key === key);
  if (u) void send(u, true);
}

/** Cancel: the file stops (what reached the server is deleted) and never starts again by itself; Retry starts it. */
export function cancelImports(keys: number[]): void {
  for (const k of keys) {
    cancelled.add(k);
    controllers.get(k)?.abort();
  }
  useImportQueue.setState((s) => ({ items: s.items.map((u) => (keys.includes(u.key) && going(u) ? { ...u, status: "cancelled", error: undefined } : u)) }));
}

async function send(u: QueueItem, retry = false): Promise<void> {
  if (cancelled.has(u.key) && !retry) return;
  // on its way already (Retry pressed twice)
  if (controllers.get(u.key)?.signal.aborted === false) return;
  const ctl = new AbortController();
  controllers.set(u.key, ctl);
  // a cancelled run still finishing never writes over the Retry that came after it
  const mine = () => controllers.get(u.key) === ctl;
  const lib = u.libraryId;
  try {
    let here = u.path ?? (await pathOnMac(u.file));
    // a file in the library already never goes, nor is taken in where it is (a failed check: the server checks too).
    // Indexed on the Mac it is matched by its first and last MiB, so no gigabytes are hashed here
    const dup = u.mac
      ? u.copyTo
        ? await gates.server(async () => (await checkUpload(lib, u.file.size, `mac:${await quickPrint(u.file)}`).catch(() => null))?.duplicateOf ?? null)
        : null
      : await gates.server(() => alreadyThere(lib, u.file, () => ctl.signal.aborted || patch(u.key, { status: "checking", error: undefined })).catch(() => null));
    ctl.signal.throwIfAborted();
    if (dup) return patch(u.key, { status: "duplicate", sent: u.file.size, error: undefined });
    // copied into the library's folder on this Mac first (the Mac app does it), then taken in from there
    if (u.copyTo && here) {
      const from = here;
      here = await gates.copy(volumeOf(u.copyTo), () => (ctl.signal.throwIfAborted(), copyFirst(u, from, ctl.signal)));
      patch(u.key, { path: here, copyTo: undefined });
    }
    const at = here;
    const r = await gates.index(() => {
      ctl.signal.throwIfAborted();
      patch(u.key, { status: "uploading", sent: 0, error: undefined });
      return uploadFile(lib, u.file, (sent, inPlace) => patch(u.key, { sent, inPlace }), u.folderId, at, { signal: ctl.signal, onMac: u.mac });
    });
    patch(u.key, r.duplicateOf || r.duplicate ? { status: "duplicate", sent: u.file.size } : { status: "added", sent: u.file.size, assetId: r.assetId });
    for (const fn of landed) fn(lib, u.folderId);
  } catch (e) {
    if (ctl.signal.aborted) {
      if (mine()) patch(u.key, { status: "cancelled", error: undefined });
    } else patch(u.key, { status: "failed", error: message(e), final: ["too_large", "not_uploaded"].includes((e as { code?: string }).code ?? "") });
  } finally {
    if (mine()) controllers.delete(u.key);
  }
}

/** One file's copy, its bytes counted on its card; Cancel stops it and the Mac removes the part written. */
async function copyFirst(u: QueueItem, from: string, signal: AbortSignal): Promise<string> {
  const id = `copy-${u.key}-${Date.now()}`;
  patch(u.key, { status: "copying", sent: 0, error: undefined });
  const tick = setInterval(() => void importProgress(id).then((p) => patch(u.key, { sent: p.bytes }), () => {}), 500);
  const stop = () => void importCancel(id).catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  try {
    const r = await importCopy(id, [{ from, to: u.copyTo! }]);
    signal.throwIfAborted();
    if (!r.copied[0]) throw new Error(r.failed[0]?.error ?? "Could not copy the file");
    return r.copied[0].to;
  } finally {
    clearInterval(tick);
    signal.removeEventListener("abort", stop);
  }
}

/** For tests: an empty queue. */
export function resetImportQueue(): void {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
  cancelled.clear();
  useImportQueue.setState({ items: [], startedAt: 0, usd: null });
}
