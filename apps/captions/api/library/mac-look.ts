import { LIBRARY_LOOK_KIND, type DeviceJob } from "../../contracts/devices";
import { wakeEditorPolls } from "../lib/mac-claude";
import type { DeviceJobSlot } from "../lib/plugin";
import { libraryChanged } from "./access";
import { libraryDb } from "./db";
import { defer, extendLease, finishJob, firstClips } from "./jobs";
import { SHEET_STRETCHES } from "./look";
import { MAC_WAITS, SHEET_FORMAT, type LookSheet } from "./shots";
import { parseSignal, takeSignal } from "./stretches";

/**
 * Shot descriptions of a file kept on a Mac with nothing uploaded (tasks/flywheel/PLAN.md 2.11, D5). Its look job waits
 * (shots.ts MAC_WAITS) until the Mac the file is on takes it on the device job road (contracts/devices.ts
 * LIBRARY_LOOK_KIND; the Mac app's LibraryLookJob.swift). That Mac reads the picture and sends it as numbers, so the
 * stretches are found here as for the server's own read (D4); it makes the sheets the server's look makes, keeps them,
 * and sends them. The look lane (worker.ts) then asks the job's actor's AI from them, as for a file the server holds
 * (shots.ts lookFromSheets), and drops them: the sheets are held in memory until that call and never written here.
 * Only the Mac in the version's mac_device takes it, and only when its account added the file; one look at a time.
 */

/** How long a Mac holds a look without a word (it beats once a minute while it reads). */
const LEASE_S = 300;
/** Sheets one look may send: six hours of footage at about 600 stretches an hour. */
const MOST_SHEETS = 400;
const JPEG_MAX = 4 * 1024 * 1024;

type Sheet = LookSheet & { ph: string[] };
/** The looks Macs hold now, by job id: the Mac, the version, its length, and the sheets sent so far. */
const held = new Map<number, { device: string; versionId: string; libraryId: string; duration: number; sheets: Sheet[] }>();
/** The sheets a Mac finished sending, by version, until the look lane takes them for its AI call. */
const sent = new Map<string, LookSheet[]>();

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
    held.delete(id);
    return undefined;
  }
  return h;
}
const busy = (device: string) => [...held.keys()].some((id) => holding(device, id));

/** The look waiting for `device`: parked for the Mac its file is on, added by the Mac's own account; edits' files first. */
function nextFor(device: string, owner: string) {
  return libraryDb()
    .prepare(
      `SELECT j.id, j.library_id, v.id AS version_id, v.mac_path, v.probe FROM jobs j
         JOIN asset_versions v ON v.id = j.version_id JOIN assets a ON a.id = v.asset_id
       WHERE j.kind = 'look' AND j.state = 'needs_key' AND j.error = ? AND v.source_key LIKE 'mac:%' AND v.mac_device = ?
         AND v.created_by = ? AND a.trashed_at IS NULL
       ORDER BY v.id IN (SELECT value FROM json_each(?)) DESC, j.id LIMIT 1`,
    )
    .get(MAC_WAITS, device, owner, JSON.stringify(firstClips())) as { id: number; library_id: string; version_id: string; mac_path: string; probe: string | null } | undefined;
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
  waits: (owner, device) => !busy(device) && !!nextFor(device, owner),
  claim: (d): DeviceJob | null => {
    if (busy(d.id)) return null;
    const r = nextFor(d.id, d.owner);
    if (!r) return null;
    const db = libraryDb();
    const now = Date.now();
    // the lane's claim that parked it counted this try
    db.prepare("UPDATE jobs SET state = 'running', lease_until = ?, started_at = ?, error = NULL WHERE id = ?").run(now + LEASE_S * 1000, now, r.id);
    const duration = Number((JSON.parse(r.probe ?? "null") as { duration?: number } | null)?.duration) || 0;
    held.set(r.id, { device: d.id, versionId: r.version_id, libraryId: r.library_id, duration, sheets: [] });
    libraryChanged(r.library_id);
    const stretches = (db.prepare("SELECT a, b FROM stretches WHERE version_id = ? AND source = 'ai' ORDER BY seg").all(r.version_id) as { a: number; b: number }[]).map((s) => [s.a, s.b]);
    return {
      id: r.id,
      kind: LIBRARY_LOOK_KIND,
      editId: "",
      variant: "",
      options: { path: r.mac_path, version: r.version_id, duration: String(duration), format: SHEET_FORMAT, stretches: JSON.stringify(stretches) },
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
      return { reply: { stretches: takeSignal(db, h.versionId, h.duration, x).map(({ seg, a, b }) => ({ seg, a, b })) } };
    }
    if (b.sheet !== undefined) {
      const sheet = parseSheet(b.sheet);
      if (typeof sheet === "string") return { error: sheet, status: 400 };
      if (h.sheets.length >= MOST_SHEETS) return { error: `A look sends ${MOST_SHEETS} sheets at most`, status: 413 };
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
    held.delete(id);
    // back to the look lane, the try not counted again: it asks the AI from the sheets (worker.ts)
    defer(db, id, 0);
    libraryChanged(h.libraryId);
    void wakeEditorPolls(); // the Mac's long poll hears of its next look at once
    return { reply: {} };
  },
  file: async () => ({ error: "Send the sheets as JSON.", status: 400 }),
  fail: (device, id, why) => {
    const h = holding(device, id);
    if (!h) return false;
    held.delete(id);
    finishJob(libraryDb(), id, false, why.slice(0, 500));
    libraryChanged(h.libraryId);
    void wakeEditorPolls();
    return true;
  },
};
