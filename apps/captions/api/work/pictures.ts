/**
 * Search by picture's vectors made on the uploader's own computers (library/pictures.ts picturesHere: the server makes
 * them only as This Mac, or where its video work is on and none of these is online). Nothing is queued: a computer that claims work and said it runs the picture
 * model is handed a clip of its account's that still lacks vectors (contracts/work.ts PicturePackage), once its account
 * may read it (offline.ts mayRead, asked again for its input). It reads the server's card picture and look sheets, or
 * the sheets the Mac the file is on keeps, runs the model and sends only the vectors back: the pictures are never kept
 * here for it. No computer online: the clips wait without vectors and search finds them by their words.
 */
import { Hono, type Context } from "hono";
import { readFile } from "node:fs/promises";
import type { Device } from "../../contracts/providers";
import { WORK_MIN, WORK_V, type PictureInput, type PicturePackage, type PictureResult } from "../../contracts/work";
import { PICTURE_DIM, PICTURE_MODEL } from "../lib/device-picture";
import { serverKind } from "./server-work";
import { offOf } from "../lib/balance";
import { deviceForToken, touchDevice } from "../lib/devices";
import { libraryChanged } from "../library/access";
import { blobs, libraryDb } from "../library/db";
import { firstClips } from "../library/jobs";
import { CARD_SEG, storePictures, storeShots } from "../library/pictures";
import { keptSheets } from "../library/shots";
import { stretchesOf } from "../library/stretches";
import { mayRead } from "./offline";

const LEASE_MS = 5 * 60_000;
/** A clip whose vectors failed, or whose account may not read it, is not handed out again for this long. */
const RETRY_MS = 60 * 60_000;

/** A computer whose worker runs the picture model, and that its person did not set to Off in Load balancing. */
const takesPictures = (d: Device): boolean => !!d.work?.pictures && d.work.v >= WORK_MIN && !offOf(d.owner).has(d.id);

type Hold = { device: string; versionId: string; libraryId: string; assetId: string; owner: string; card: boolean; sheets: PicturePackage["sheets"]; shots: string; until: number };
// ponytail: in memory (library jobs keep their holder on the jobs row); a restart hands the clips out again
const held = new Map<number, Hold>();
const tried = new Map<string, number>();
let nextId = 1;

/** The clip `id` while `device` holds it; a hold that ran out is let go. */
function holding(id: number, device: string): Hold | undefined {
  const h = held.get(id);
  if (!h || h.device !== device) return undefined;
  if (h.until < Date.now()) return void held.delete(id);
  return h;
}
const busy = (device: string) => [...held.keys()].some((id) => holding(id, device));

type Todo = { version_id: string; asset_id: string; library_id: string; card: number; shots_in: number; sheets: number };

/**
 * The clips `d`'s account added that still lack vectors it can make, edits' clips first: a card picture with no vector,
 * or a look's sheets (the server's, or for a file kept on a Mac, that Mac's once its look is done) with no shot vectors.
 * A file kept on a Mac goes only to that Mac. Leaves out the ones held or tried lately.
 */
function todo(d: Device, now = Date.now()): Todo[] {
  const shotsIn = `(EXISTS (SELECT 1 FROM derivatives x WHERE x.version_id = v.id AND x.kind = 'looksheets' AND x.storage_key IS NOT NULL)
    OR (v.source_key LIKE 'mac:%' AND EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = 'look' AND j.state = 'done')))`;
  const rows = libraryDb()
    .prepare(
      `SELECT v.id AS version_id, a.id AS asset_id, a.library_id, ${shotsIn} AS shots_in,
         EXISTS (SELECT 1 FROM derivatives x WHERE x.version_id = v.id AND x.kind = 'thumb' AND x.storage_key IS NOT NULL) AS card,
         EXISTS (SELECT 1 FROM derivatives x WHERE x.version_id = v.id AND x.kind = 'looksheets' AND x.storage_key IS NOT NULL) AS sheets
       FROM asset_versions v JOIN assets a ON a.current_version_id = v.id JOIN libraries l ON l.id = a.library_id
       WHERE v.created_by = ? AND a.trashed_at IS NULL AND a.kind IN ('video', 'image') AND COALESCE(json_extract(l.settings, '$.pictures'), 1)
         AND (v.source_key NOT LIKE 'mac:%' OR v.mac_device = ?)
         AND ((EXISTS (SELECT 1 FROM derivatives x WHERE x.version_id = v.id AND x.kind = 'thumb' AND x.storage_key IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM pictures p WHERE p.version_id = v.id AND p.model = ? AND p.seg = -1))
           OR (${shotsIn} AND NOT EXISTS (SELECT 1 FROM pictures p WHERE p.version_id = v.id AND p.model = ? AND p.seg >= 0)))
       ORDER BY v.id IN (SELECT value FROM json_each(?)) DESC, v.id LIMIT 50`,
    )
    .all(d.owner, d.id, PICTURE_MODEL, PICTURE_MODEL, JSON.stringify(firstClips())) as Todo[];
  const out = new Set([...held.values()].filter((h) => h.until >= now).map((h) => h.versionId));
  return rows.filter((r) => !out.has(r.version_id) && (tried.get(r.version_id) ?? 0) <= now);
}

/** The look's stretches of a version, [[a, b], …], as a Mac keeps its sheets of them (library/mac-look.ts). */
const aiStretches = (versionId: string): number[][] =>
  (libraryDb().prepare("SELECT a, b FROM stretches WHERE version_id = ? AND source = 'ai' ORDER BY seg").all(versionId) as { a: number; b: number }[]).map((s) => [s.a, s.b]);

/** Whether picture work waits that `d` would be handed now: its device runner's long poll starts the worker. */
export const picturesWait = (d: Device): boolean => serverKind() !== "local" && takesPictures(d) && !busy(d.id) && todo(d).length > 0;

/** The clip computer `d` makes vectors for now, or null: one at a time, only what its account may read. */
export async function claimPictures(d: Device, now = Date.now()): Promise<PicturePackage | null> {
  if (serverKind() === "local" || !takesPictures(d) || busy(d.id)) return null;
  for (const r of todo(d, now)) {
    if (!(await mayRead(d.owner, r.library_id, r.asset_id, r.version_id))) {
      tried.set(r.version_id, now + RETRY_MS);
      continue;
    }
    const sheets: PicturePackage["sheets"] = !r.shots_in ? null : r.sheets ? "server" : "here";
    const stretches = aiStretches(r.version_id);
    const id = nextId++;
    held.set(id, { device: d.id, versionId: r.version_id, libraryId: r.library_id, assetId: r.asset_id, owner: d.owner, card: !!r.card, sheets, shots: JSON.stringify(stretches), until: now + LEASE_MS });
    return { v: WORK_V, id, versionId: r.version_id, card: !!r.card, sheets, ...(sheets === "here" ? { stretches } : {}) };
  }
  return null;
}

/** The hold, while its account may still read the clip; one it may not is let go and not handed out again for a while. */
async function seen(id: number, device: string): Promise<Hold | undefined> {
  const h = holding(id, device);
  if (!h) return undefined;
  if (await mayRead(h.owner, h.libraryId, h.assetId, h.versionId)) return h;
  held.delete(id);
  tried.set(h.versionId, Date.now() + RETRY_MS);
  return undefined;
}

/** A base64 vector, checked: PICTURE_DIM finite numbers. */
function vecOf(x: unknown): Float32Array | null | undefined {
  if (x === null) return null;
  if (typeof x !== "string") return undefined;
  const b = Buffer.from(x, "base64");
  if (b.length !== PICTURE_DIM * 4) return undefined;
  const v = new Float32Array(Uint8Array.from(b).buffer);
  return v.every(Number.isFinite) ? v : undefined;
}

/** Files a computer's vectors while it holds the clip: the card's and the shots' asked for; shots of stretches since found again are dropped. */
export function applyPictures(id: number, device: string, r: PictureResult): boolean {
  const h = holding(id, device);
  if (!h || !Array.isArray(r?.rows)) return false;
  held.delete(id);
  const db = libraryDb();
  const segs = new Set(stretchesOf(db, h.versionId).map((s) => s.seg));
  const rows = r.rows.slice(0, 100_000).flatMap((x) => {
    const vec = vecOf(x?.vec);
    return vec !== undefined && Number.isSafeInteger(x.seg) ? [{ seg: x.seg, vec }] : [];
  });
  const card = rows.find((x) => x.seg === CARD_SEG);
  if (h.card) storePictures(db, h.versionId, [{ seg: CARD_SEG, start: 0, vec: card?.vec ?? null }], false);
  if (h.sheets && (h.sheets === "server" || JSON.stringify(aiStretches(h.versionId)) === h.shots)) storeShots(db, h.versionId, rows.filter((x) => x.seg >= 0 && segs.has(x.seg)));
  libraryChanged(h.libraryId);
  return true;
}

function caller(c: Context): Device | null {
  const d = deviceForToken(c.req.header("authorization"));
  if (d) touchDevice(d.id, c.req.header("user-agent"));
  return d;
}
const idOf = (c: Context): number => {
  const n = Number(c.req.param("id"));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** Mounted at /api/devices/relay/work/pictures (api/work/routes.ts), with the device's ctd_ token. */
export const picturesWorkApp = new Hono();

picturesWorkApp.post("/:id/beat", (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const h = holding(idOf(c), d.id);
  if (h) h.until = Date.now() + LEASE_MS;
  return c.json({ ok: !!h });
});

picturesWorkApp.get("/:id/input", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const h = await seen(idOf(c), d.id);
  if (!h) return c.json({ error: "Not found" }, 404);
  const db = libraryDb();
  const thumb = h.card ? (db.prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = 'thumb'").get(h.versionId) as { storage_key: string | null } | undefined) : undefined;
  const card = thumb?.storage_key ? await blobs.localCopy(thumb.storage_key).then((f) => readFile(f)).catch(() => null) : null;
  const sheets = h.sheets === "server" ? (await keptSheets(db, h.versionId))?.sheets : undefined;
  const input: PictureInput = { ...(card ? { card: card.toString("base64") } : {}), ...(sheets ? { sheets: sheets.map(({ segs, jpeg }) => ({ segs, jpeg })) } : {}) };
  return c.json(input);
});

picturesWorkApp.post("/:id/done", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const r = (await c.req.json().catch(() => null)) as PictureResult | null;
  return c.json({ ok: !!r && applyPictures(idOf(c), d.id, r) });
});

picturesWorkApp.post("/:id/fail", (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const h = holding(idOf(c), d.id);
  if (h) {
    held.delete(idOf(c));
    tried.set(h.versionId, Date.now() + RETRY_MS);
  }
  return c.json({ ok: !!h });
});
