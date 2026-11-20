import { readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { LIBRARY_LOOK_KIND, type DeviceJob } from "../../contracts/devices";
import type { Device } from "../../contracts/providers";
import type { StorageFolder } from "../../contracts/storage";
import { balanceNow, mayClaim, type WorkerSeen } from "../lib/balance";
import { deviceOf, listDevices, setDeviceLooks } from "../lib/devices";
import { wakeEditorPolls } from "../lib/mac-claude";
import type { DeviceJobSlot } from "../lib/plugin";
import { parseStorageFile, storageFilePath, withMounts } from "../lib/storage";
import { libraryChanged } from "./access";
import { libraryDb, libraryLookLevel } from "./db";
import { defer, extendLease, finishJob, firstClips } from "./jobs";
import { SHEET_STRETCHES } from "./look";
import { triesOn } from "./places";
import { MAC_WAITS, SHEET_FORMAT, type LookSheet } from "./shots";
import { parseSignal, storeStretches, stretchLevelOf, takeSignal } from "./stretches";
import { WATCH_LEVELS, wantsWatch } from "./timeline";
import { resolveDevice } from "./whereis";
import { mayLeave } from "./upload-gate";
import { env } from "../lib/env";
import type { LookLevel } from "../../contracts/library";

/**
 * Shot descriptions of a file kept on a Mac with nothing uploaded (tasks/flywheel/PLAN.md 2.11, D5). Its look job waits
 * (shots.ts MAC_WAITS) until the Mac the file is on takes it on the device job road (contracts/devices.ts
 * LIBRARY_LOOK_KIND; the Mac app's LibraryLookJob.swift). That Mac reads the picture and sends it as numbers, so the
 * stretches are found here as for the server's own read (D4); it makes the sheets the server's look makes, keeps them,
 * and sends them. The look lane (worker.ts) then asks the job's actor's AI from them, as for a file the server holds
 * (shots.ts lookFromSheets), and drops them: the sheets are held in memory until that call and never written here.
 * A computer of the account that added the file takes it, one that reaches the file (a file kept on a Mac: that Mac, or
 * another that connects the share it is on, as a Linux computer's worker does, api/work/look.ts); of several, the best
 * placed under load balancing (placedOn). One look at a time each.
 * The Mac keeps its sheets; each claim it makes says which versions it keeps them for, and the answer names the ones it
 * may drop (lookSheetsClaim). Settings → Storage counts them and empties them (api/kept.ts).
 * With a Gemini key and Timelines on (timeline.ts wantsWatch), the claim also asks for a small copy of the video (option
 * `watch`: the frames a second Gemini samples); the Mac posts it to …/file before done, and the look lane sends it to
 * Gemini and deletes it (takeWatchCopy). It is held only until then.
 */

/** How long a Mac holds a look without a word (it beats once a minute while it reads). */
const LEASE_S = 300;
/**
 * The most one look may send: its sheets' JPEGs together, all held in memory until the AI's call. About ten hours of
 * footage at 250 KB a sheet of 16 stretches; one sheet is at most JPEG_MAX.
 */
export const LOOK_BYTES_MAX = 100_000_000;
const JPEG_MAX = 4 * 1024 * 1024;
/** The most a Mac's copy for the timeline may be: what Gemini's Files API takes on its free tier. */
const WATCH_COPY_MAX = 2 * 1024 ** 3;
/** Why a look past LOOK_BYTES_MAX failed: it stays failed, since the same file sends the same sheets again. */
export const TOO_BIG = "This video is too long to describe shot by shot: its sheets come to more than 100 MB.";

type Sheet = LookSheet & { ph: string[] };
/** The looks Macs hold now, by job id: the Mac, the version, its length, and the sheets sent so far and their bytes. */
const held = new Map<number, { device: string; versionId: string; libraryId: string; duration: number; level: LookLevel; sheets: Sheet[]; bytes: number; watch: boolean; copy?: string }>();
/**
 * The sheets a Mac finished sending, by version, until the look lane takes them for its AI call. Only in memory: a
 * restart loses them and the look waits for the Mac again (lookOnMac), which sends the sheets it kept, its video unread.
 * A restart costs a resend of the sheets, never a second read of the picture, so they are not written here.
 */
const sent = new Map<string, LookSheet[]>();
/** Each computer's latest look claim (look jobs carry no held_by): the wait status reads it (work/waits.ts). */
const lastTaken = new Map<string, { id: number; at: number }>();
// shortcut: only the latest claim is kept, so an older look taken after a newer one hides it; keep a list if that misleads
export const tookLookAfter = (device: string, jobId: number, since: number): boolean => {
  const t = lastTaken.get(device);
  return !!t && t.at >= since && t.id > jobId;
};
/** The copies for the timeline a Mac sent with its sheets, by version, until the look lane takes them (a file each). */
const copies = new Map<string, string>();

/** The copy a Mac sent of `versionId` for its timeline, now the caller's to delete; null when none came. */
export function takeWatchCopy(versionId: string): string | null {
  const f = copies.get(versionId) ?? null;
  copies.delete(versionId);
  return f;
}
const dropCopy = (f?: string) => void (f && rm(f, { force: true }).catch(() => {}));

/** Whether a Mac sent the sheets of `versionId` and the look lane has not taken them yet. */
export const macSheetsWaiting = (versionId: string): boolean => sent.has(versionId);

/** The sheets a Mac sent for `versionId`, now the caller's (the look lane's); null when none came. */
export function takeMacSheets(versionId: string): LookSheet[] | null {
  const sheets = sent.get(versionId) ?? null;
  sent.delete(versionId);
  return sheets;
}

/** The look `id` while `device` holds it (running, its lease not out); a hold that ran out is let go. */
function holding(device: string, id: number) {
  const h = held.get(id);
  if (!h || h.device !== device) return undefined;
  if (!libraryDb().prepare("SELECT 1 FROM jobs WHERE id = ? AND state = 'running' AND lease_until >= ?").get(id, Date.now())) {
    dropCopy(h.copy);
    held.delete(id);
    return undefined;
  }
  return h;
}
const busy = (device: string) => [...held.keys()].some((id) => holding(device, id));

/** Whether `device` holds a look now (pure read: never mutates `held` or deletes a copy). */
export function lookHeldOn(device: string, now = Date.now()): boolean {
  const ids = [...held].flatMap(([id, h]) => (h.device === device ? [id] : []));
  return (
    ids.length > 0 &&
    !!libraryDb()
      .prepare(`SELECT 1 FROM jobs WHERE id IN (${ids.map(() => "?").join(", ")}) AND state = 'running' AND lease_until >= ? LIMIT 1`)
      .get(...ids, now)
  );
}

export type PlaceRow = {
  version_id: string;
  source_key: string;
  source_path?: string | null;
  mac_path: string | null;
  mac_device: string | null;
  from_path: string | null;
  from_device: string | null;
};
const PLACE_COLS = "v.id AS version_id, v.source_key, v.source_path, v.mac_path, v.mac_device, v.from_path, v.from_device";

/** Set by work/library-package.ts at load so look reach shares fileFor without a static import loop. */
export const lookReach: { at?: (device: string, r: PlaceRow, folders: StorageFolder[]) => string | null } = {};

function lookFolders(owner: string): StorageFolder[] {
  let raw = "{}";
  try {
    raw = readFileSync(storageFilePath(env.dataDir, owner), "utf-8");
  } catch {
    // no folders set yet
  }
  const folders = parseStorageFile(raw).folders;
  return withMounts(folders, listDevices((x) => x.owner === owner).map((x) => ({ id: x.id, disks: x.report?.machine?.disks })));
}

/**
 * Where computer `device` reads a version's file: on the Mac it is kept on with nothing uploaded, or the one it was
 * uploaded from or found on since, or on a share it connects with the file's root (library/places.ts) or shared folder
 * (Settings → Storage), for a server that does no video work itself (worker.ts lookOnMac). Null when it has none.
 */
export function pathOn(device: string, r: PlaceRow, folders: StorageFolder[] = []): string | null {
  if (lookReach.at) return lookReach.at(device, r, folders);
  const useMac = r.source_key.startsWith("mac:") || !!r.mac_path || !r.from_path;
  const macPath = useMac ? r.mac_path : r.from_path;
  const rawDev = useMac ? r.mac_device : r.from_device;
  return triesOn({ id: r.version_id, mac_path: macPath, mac_device: rawDev ? resolveDevice(rawDev) : null }, device, folders)[0] ?? null;
}

/** The same window as the device road's (api/devices.ts ONLINE_MS): a computer not heard from in 40 s takes nothing. */
const ONLINE_MS = 40_000;

/**
 * Whether `device` is the one of `owner`'s computers to take this look now, as for the other library jobs
 * (work/library-package.ts): among those that reach the file, list the look and are online and free, the best under
 * load balancing (lib/balance.ts mayClaim). The one asking is always among them.
 */
export function placedOn(device: string, owner: string, r: PlaceRow, now = Date.now(), folders = lookFolders(owner)): boolean {
  const workers: WorkerSeen[] = listDevices(
    (x) =>
      x.owner === owner &&
      (x.id === device || (now - (x.lastSeen ?? 0) <= ONLINE_MS && !lookHeldOn(x.id, now) && (x.kinds ?? []).includes(LIBRARY_LOOK_KIND) && !!pathOn(x.id, r, folders))),
  )
    .filter((x) => x.report?.machine)
    .map((x) => ({ host: x.id, at: x.id === device ? now : (x.lastSeen ?? 0), machine: x.report!.machine, never: [] }));
  return mayClaim(LIBRARY_LOOK_KIND, device, workers, balanceNow(owner), now, ONLINE_MS);
}

/** Whether one of `owner`'s Macs has version `versionId`'s file, so its look can wait for that Mac. */
export function onTheirMac(versionId: string, owner: string | null): boolean {
  if (!owner) return false;
  const r = libraryDb().prepare(`SELECT ${PLACE_COLS} FROM asset_versions v WHERE v.id = ?`).get(versionId) as PlaceRow | undefined;
  if (!r) return false;
  const folders = lookFolders(owner);
  return listDevices((x) => x.owner === owner).some((x) => !!pathOn(x.id, r, folders));
}

/** The look waiting for `device`: parked for the Mac its file is on, added by the Mac's own account; edits' files first. */
export function nextFor(device: string, owner: string) {
  const rows = libraryDb()
    .prepare(
      `SELECT j.id, j.library_id, j.actor, ${PLACE_COLS}, v.probe FROM jobs j
         JOIN asset_versions v ON v.id = j.version_id JOIN assets a ON a.id = v.asset_id
       WHERE j.kind = 'look' AND j.state = 'needs_key' AND j.error = ? AND v.created_by = ? AND a.trashed_at IS NULL
       ORDER BY v.id IN (SELECT value FROM json_each(?)) DESC, j.id LIMIT 200`,
    )
    .all(MAC_WAITS, owner, JSON.stringify(firstClips())) as (PlaceRow & { id: number; library_id: string; actor: string | null; probe: string | null })[];
  if (!rows.length) return undefined;
  const folders = lookFolders(owner);
  for (const r of rows) {
    const at = pathOn(device, r, folders);
    if (at && placedOn(device, owner, r, Date.now(), folders)) return { ...r, mac_path: at };
  }
  return undefined;
}

/** A sheet from the Mac, checked: its stretches (1 to SHEET_STRETCHES), a base64 JPEG under JPEG_MAX, a hash each. */
function parseSheet(v: unknown): Sheet | string {
  const s = (v ?? {}) as Record<string, unknown>;
  const segs = s.segs;
  if (!Array.isArray(segs) || !segs.length || segs.length > SHEET_STRETCHES || !segs.every((n) => Number.isSafeInteger(n) && n >= 0))
    return `segs: the stretches on the sheet, 1 to ${SHEET_STRETCHES}`;
  const head = typeof s.jpeg === "string" && s.jpeg.length <= (JPEG_MAX * 4) / 3 + 4 ? Buffer.from(s.jpeg.slice(0, 8), "base64") : null;
  if (!head || head[0] !== 0xff || head[1] !== 0xd8) return "jpeg: the sheet as a base64 JPEG";
  const ph = segs.map((_, k) => (Array.isArray(s.ph) && typeof s.ph[k] === "string" && /^[0-9a-f]{16}$/i.test(s.ph[k]) ? (s.ph[k] as string).toLowerCase() : ""));
  return { segs: segs as number[], jpeg: s.jpeg as string, ph };
}

/** The device job road's side of it (api/devices.ts lists it with the app's own). */
export const macLookJob: DeviceJobSlot = {
  kind: LIBRARY_LOOK_KIND,
  waits: (owner, device) => !!deviceOf(device)?.looks?.clear || (!busy(device) && !!nextFor(device, owner)),
  claim: (d): DeviceJob | null => {
    if (busy(d.id)) return null;
    const r = nextFor(d.id, d.owner);
    if (!r) return null;
    const db = libraryDb();
    const now = Date.now();
    // the lane's claim that parked it counted this try
    db.prepare("UPDATE jobs SET state = 'running', lease_until = ?, started_at = ?, error = NULL WHERE id = ?").run(now + LEASE_S * 1000, now, r.id);
    const duration = Number((JSON.parse(r.probe ?? "null") as { duration?: number } | null)?.duration) || 0;
    // stretches found at another level than the library's are found again: the Mac reads the picture (none sent)
    const level = libraryLookLevel(r.library_id);
    if (stretchLevelOf(db, r.version_id) !== level) storeStretches(db, r.version_id, [], level);
    // Blur faces: no copy of a clip not blurred is sent here, not even for the timeline's one call (upload-gate.ts mayLeave)
    const watch = wantsWatch(db, r.version_id, r.actor) && mayLeave(r.library_id, { versionId: r.version_id }).ok;
    lastTaken.set(d.id, { id: r.id, at: Date.now() });
    held.set(r.id, { device: d.id, versionId: r.version_id, libraryId: r.library_id, duration, level, sheets: [], bytes: 0, watch });
    libraryChanged(r.library_id);
    const stretches = (db.prepare("SELECT a, b FROM stretches WHERE version_id = ? AND source = 'ai' ORDER BY seg").all(r.version_id) as { a: number; b: number }[]).map((s) => [s.a, s.b]);
    return {
      id: r.id,
      kind: LIBRARY_LOOK_KIND,
      editId: "",
      variant: "",
      options: {
        path: r.mac_path,
        version: r.version_id,
        duration: String(duration),
        format: SHEET_FORMAT,
        stretches: JSON.stringify(stretches),
        ...(watch ? { watch: String(WATCH_LEVELS[level].fps) } : {}),
      },
    };
  },
  input: async () => null,
  answer: async (device, id, body) => {
    const h = holding(device, id);
    if (!h) return { error: "Not found", status: 404 };
    const db = libraryDb();
    extendLease(db, id, LEASE_S);
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.beat === true) return { reply: {} };
    if (b.signal !== undefined) {
      const x = parseSignal(b.signal);
      if (typeof x === "string") return { error: x, status: 400 };
      h.sheets = [];
      h.bytes = 0;
      return { reply: { stretches: takeSignal(db, h.versionId, h.duration, x, h.level).map(({ seg, a, b }) => ({ seg, a, b })) } };
    }
    if (b.sheet !== undefined) {
      const sheet = parseSheet(b.sheet);
      if (typeof sheet === "string") return { error: sheet, status: 400 };
      h.bytes += Buffer.byteLength(sheet.jpeg, "base64");
      if (h.bytes > LOOK_BYTES_MAX) {
        // for good: the file would send the same sheets again; Retry or Describe again on the clip asks once more
        dropCopy(h.copy);
        held.delete(id);
        db.prepare("UPDATE jobs SET state = 'failed', lease_until = NULL, error = ? WHERE id = ?").run(TOO_BIG, id);
        libraryChanged(h.libraryId);
        void wakeEditorPolls();
        return { error: TOO_BIG, status: 413 };
      }
      h.sheets.push(sheet);
      return { reply: {} };
    }
    if (b.done !== true) return { error: "Send a beat, the picture, a sheet or done", status: 400 };
    if (b.format !== SHEET_FORMAT) return { error: "These sheets are of another format: update Creator Toolset on the Mac", status: 409 };
    const segs = (db.prepare("SELECT seg FROM stretches WHERE version_id = ? AND source = 'ai' ORDER BY seg").all(h.versionId) as { seg: number }[]).map((r) => r.seg);
    const on = h.sheets.flatMap((s) => s.segs).sort((x, y) => x - y);
    if (!segs.length || on.join() !== segs.join()) return { error: "The sheets don't show the file's stretches: read its picture again", status: 409 };
    const put = db.prepare("UPDATE stretches SET ph = ? WHERE version_id = ? AND seg = ? AND source = 'ai'");
    for (const s of h.sheets) s.ph.forEach((ph, k) => ph && put.run(ph, h.versionId, s.segs[k]!));
    sent.set(h.versionId, h.sheets.map(({ segs, jpeg }) => ({ segs, jpeg })));
    if (h.copy) {
      dropCopy(copies.get(h.versionId));
      copies.set(h.versionId, h.copy);
    }
    held.delete(id);
    // back to the look lane, the try not counted again: it asks the AI from the sheets (worker.ts)
    defer(db, id, 0);
    libraryChanged(h.libraryId);
    void wakeEditorPolls(); // the Mac's long poll hears of its next look at once
    return { reply: {} };
  },
  // the copy for the timeline, when the claim asked for one: moved out of the upload's place, kept until the lane takes it
  file: async (device, id, file) => {
    const h = holding(device, id);
    if (!h) return { error: "Not found", status: 404 };
    if (!h.watch) return { error: "Send the sheets as JSON.", status: 400 };
    if ((await stat(file)).size > WATCH_COPY_MAX) return { error: "The copy for the timeline is too big.", status: 413 };
    extendLease(libraryDb(), id, LEASE_S);
    const dir = path.join(env.dataDir, "library", "scratch");
    const dest = path.join(dir, `watch-${h.versionId}-${id}.mp4`);
    await mkdir(dir, { recursive: true });
    await rename(file, dest);
    dropCopy(h.copy);
    h.copy = dest;
    return { reply: {} };
  },
  fail: (device, id, why) => {
    const h = holding(device, id);
    if (!h) return false;
    dropCopy(h.copy);
    held.delete(id);
    finishJob(libraryDb(), id, false, why.slice(0, 500));
    libraryChanged(h.libraryId);
    void wakeEditorPolls();
    return true;
  },
};

/** The sheets a Mac keeps, as its claim says (contracts/devices.ts DeviceClaimBody.looks): bytes by version; null when not said. */
function parseKept(v: unknown): Map<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = new Map<string, number>();
  for (const [id, bytes] of Object.entries(v as Record<string, unknown>).slice(0, 20_000))
    if (/^[\w-]{1,100}$/.test(id) && typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0) out.set(id, bytes);
  return out;
}

/**
 * A Mac's claim lists the versions it keeps sheets for: kept as its count for Settings → Storage, and answered with
 * those it may drop, every version that is gone, in the trash, or no longer the file on this Mac of this account's.
 * After Empty (emptyLookSheets) the answer says to drop them all. Undefined when the claim says nothing of sheets
 * (an older Mac app).
 */
export function lookSheetsClaim(d: Device, body: unknown): { gone: string[]; clear?: true } | undefined {
  const kept = parseKept(body);
  if (!kept) return undefined;
  if (deviceOf(d.id)?.looks?.clear) {
    setDeviceLooks(d.id, { bytes: 0, items: 0 });
    return { gone: [], clear: true };
  }
  const mine = libraryDb().prepare(
    "SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL AND v.source_key LIKE 'mac:%' AND v.mac_device = ? AND v.created_by = ?",
  );
  const gone = [...kept.keys()].filter((v) => !mine.get(v, d.id, d.owner));
  for (const v of gone) kept.delete(v);
  setDeviceLooks(d.id, { bytes: [...kept.values()].reduce((n, b) => n + b, 0), items: kept.size });
  return { gone };
}

/** The sheets `owner`'s Macs keep, by their last claims (Settings → Storage). */
export function lookSheetsOf(owner: string): { bytes: number; items: number } {
  const own = listDevices((d) => d.owner === owner);
  return { bytes: own.reduce((n, d) => n + (d.looks?.bytes ?? 0), 0), items: own.reduce((n, d) => n + (d.looks?.items ?? 0), 0) };
}

/**
 * Settings → Storage → Empty: each of `owner`'s Macs that keeps sheets drops them all, told on its next claim (its long
 * poll is woken for it now). A look of a version whose sheets went makes them from the video again.
 */
export function emptyLookSheets(owner: string): void {
  for (const d of listDevices((x) => x.owner === owner && !!(x.looks?.items || x.looks?.bytes))) setDeviceLooks(d.id, { bytes: 0, items: 0, clear: true });
  void wakeEditorPolls();
}
