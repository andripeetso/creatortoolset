import { Hono } from "hono";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "../../api/auth";
import { env } from "../../api/lib/env";
import { emitEvent } from "../../api/lib/events";
import { fileBlur, libraryDb } from "../../api/library/db";
import { libraryAccount } from "../../api/library/routes";
import { deleteVersions } from "../../api/library/trash";
import { mayKeepAsFilmed } from "../../api/library/upload-gate";
import { checkMade, HEX64, recordCopy } from "./copy";

/**
 * Blurred copies made before Face Blur (by hand, or by another tool), added to the clips they belong to so nothing is
 * blurred again. One-time, for the library's owner or an admin (README.md, "Blurred copies made before").
 *   POST   /api/x/blur-faces/reconnect   { libraryId, dry?, rows: Row[] } → { rows: Outcome[] }
 *   DELETE /api/x/blur-faces/reconnect?libraryId=   undoes every applied row of that library, newest first
 * Per row, the clip is found by `versionId`, or by `path`: the original's path on its Mac (mac_path or a place).
 *   link:   the original is marked Blur faces and `copy` (a file on the same Mac) becomes its current, blurred version,
 *           as Face Blur's own copy does (copy.ts recordCopy); `originalSha256` is the original's full SHA-256
 *   self:   the file is already blurred: it is its own blurred version (blurred_of = its own SHA-256)
 *   filmed: kept as filmed (answer no)
 * Nothing is queued for Face Blur and no file is moved or deleted. Each applied row is logged with what it changed
 * (<data dir>/plugins/blur-faces/reconnect-log.jsonl), which the undo replays backwards.
 */

export const RECONNECT_MAX = 500;
const ACTIONS = ["link", "self", "filmed"] as const;
type Action = (typeof ACTIONS)[number];
type Row = { versionId?: string; path?: string; size?: number; action: Action; originalSha256?: string; copy?: unknown };
export type Outcome = { i: number; versionId?: string; result: "linked" | "blurred" | "filmed" | "done before" | "merge-needed" | "error"; copyVersionId?: string; error?: string };
type Logged = {
  libraryId: string; versionId: string; assetId: string; action: Action;
  prev: { blur: string | null; full_sha256: string | null; current: string };
  added?: string;
};

const logFile = () => path.join(env.dataDir, "plugins", "blur-faces", "reconnect-log.jsonl");

type Found = { id: string; asset_id: string; bytes: number | null; full_sha256: string | null; blurred_of: string | null; mac_device: string | null; blur: string | null; current: string };
/** The library's original by its id or its path on a Mac (not trashed), with the Mac that has it. */
function findVersion(libraryId: string, r: Row): (Found & { device: string | null }) | undefined {
  const d = libraryDb();
  const v = d
    .prepare(
      `SELECT v.id, v.asset_id, v.bytes, v.full_sha256, v.blurred_of, v.mac_device, a.blur, a.current_version_id AS current
         FROM asset_versions v JOIN assets a ON a.id = v.asset_id
        WHERE a.library_id = ? AND a.trashed_at IS NULL AND (v.id = ? OR v.mac_path = ? OR v.id IN (SELECT version_id FROM version_places WHERE path = ?))
        ORDER BY v.n LIMIT 1`,
    )
    .get(libraryId, r.versionId ?? "", r.path ?? "", r.path ?? "") as Found | undefined;
  if (!v) return undefined;
  const place = v.mac_device ? null : (d.prepare("SELECT device FROM version_places WHERE version_id = ? LIMIT 1").get(v.id) as { device: string } | undefined);
  return { ...v, device: v.mac_device ?? place?.device ?? null };
}

/** What is wrong with the body, or the rows. */
export function checkRows(b: unknown): { libraryId: string; dry: boolean; rows: Row[] } | string {
  const p = b as { libraryId?: unknown; dry?: unknown; rows?: unknown } | null;
  if (typeof p?.libraryId !== "string" || !p.libraryId) return "Send the libraryId.";
  if (!Array.isArray(p.rows) || !p.rows.length) return "Send the rows.";
  if (p.rows.length > RECONNECT_MAX) return `At most ${RECONNECT_MAX} rows at a time.`;
  for (const r of p.rows as Partial<Row>[]) {
    if (!r || !ACTIONS.includes(r.action as Action)) return "Each row's action is link, self or filmed.";
    if (typeof r.versionId !== "string" && typeof r.path !== "string") return "Each row needs a versionId or a path.";
    if (r.action !== "filmed" && (typeof r.originalSha256 !== "string" || !HEX64.test(r.originalSha256))) return "originalSha256 is 64 hex characters.";
  }
  return { libraryId: p.libraryId, dry: p.dry === true, rows: p.rows as Row[] };
}

async function one(libraryId: string, owner: string, r: Row, i: number, dry: boolean): Promise<Outcome> {
  const d = libraryDb();
  const v = findVersion(libraryId, r);
  if (!v) return { i, result: "error", error: "Not found in this library" };
  const out = { i, versionId: v.id };
  if (typeof r.size === "number" && v.bytes !== null && v.bytes !== r.size) return { ...out, result: "error", error: "The file's size differs" };
  const sha = r.originalSha256 ?? ""; // checkRows: set for link and self
  if (sha && v.full_sha256 && v.full_sha256 !== sha) return { ...out, result: "error", error: "The file's SHA-256 differs" };
  const prev = { blur: v.blur, full_sha256: v.full_sha256, current: v.current };
  const log = async (entry: Omit<Logged, "libraryId" | "versionId" | "assetId" | "prev">) => {
    await mkdir(path.dirname(logFile()), { recursive: true, mode: 0o700 });
    await appendFile(logFile(), JSON.stringify({ libraryId, versionId: v.id, assetId: v.asset_id, prev, ...entry } satisfies Logged) + "\n");
  };

  if (r.action === "filmed") {
    if (!dry) {
      await log({ action: "filmed" });
      d.prepare("UPDATE assets SET blur = 'no' WHERE id = ?").run(v.asset_id);
    }
    return { ...out, result: "filmed" };
  }

  if (r.action === "self") {
    if (v.blurred_of) return { ...out, result: "done before" };
    if (!dry) {
      await log({ action: "self" });
      d.prepare("UPDATE asset_versions SET full_sha256 = COALESCE(full_sha256, ?), blurred_of = ? WHERE id = ?").run(sha, sha, v.id);
      d.prepare("UPDATE assets SET blur = 'yes' WHERE id = ?").run(v.asset_id);
    }
    return { ...out, result: "blurred" };
  }

  // link
  if (v.blurred_of || fileBlur(v.id)?.blurredVersionId) return { ...out, result: "done before" };
  const copy = checkMade(r.copy);
  if (typeof copy === "string") return { ...out, result: "error", error: copy };
  if (!copy.sha256) return { ...out, result: "error", error: "Send the copy's sha256." };
  // a "blurred" archive copy that is byte for byte its original was never blurred: linking it would mark the faces covered
  if (copy.sha256.toLowerCase() === sha.toLowerCase()) return { ...out, result: "error", error: "The copy is the original, not blurred" };
  if (!v.device) return { ...out, result: "error", error: "No computer has this file" };
  // the copy indexed before as a clip of its own: merging two clips is the person's call, not this route's
  const indexed = d
    .prepare(`SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND (v.full_sha256 = ? OR v.sha256 IN (?, ?) OR (v.quick = ? AND v.bytes = ?)) LIMIT 1`)
    .get(libraryId, copy.sha256, copy.sha256, `mac:${copy.quick}`, copy.quick, copy.size);
  if (indexed) return { ...out, result: "merge-needed" };
  // another clip with the same original would take the copy instead (originalClipOf links on the SHA-256)
  const twin = d.prepare("SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.full_sha256 = ? AND v.blurred_of IS NULL AND v.id <> ? AND a.trashed_at IS NULL LIMIT 1").get(libraryId, sha, v.id);
  if (twin) return { ...out, result: "error", error: "Another clip has the same original" };
  if (dry) return { ...out, result: "linked" };
  d.prepare("UPDATE asset_versions SET full_sha256 = ? WHERE id = ? AND full_sha256 IS NULL").run(sha, v.id);
  d.prepare("UPDATE assets SET blur = 'yes' WHERE id = ?").run(v.asset_id);
  const made = await recordCopy(libraryId, owner, v.device, copy, sha);
  if (!("versionId" in made) || fileBlur(v.id)?.blurredVersionId !== made.versionId) {
    // put the answer and hash back; a version recorded elsewhere is reported, never guessed at
    d.prepare("UPDATE assets SET blur = ? WHERE id = ?").run(prev.blur, v.asset_id);
    d.prepare("UPDATE asset_versions SET full_sha256 = ? WHERE id = ?").run(prev.full_sha256, v.id);
    return { ...out, result: "error", error: "The copy could not be added to this clip", ...("versionId" in made ? { copyVersionId: made.versionId } : {}) };
  }
  await log({ action: "link", added: made.versionId });
  return { ...out, result: "linked", copyVersionId: made.versionId };
}

/** Puts back every applied row of `libraryId`, newest first; the log keeps other libraries' rows. Returns how many. */
export async function undoReconnect(libraryId: string): Promise<number> {
  const lines = (await readFile(logFile(), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Logged);
  const mine = lines.filter((l) => l.libraryId === libraryId);
  const d = libraryDb();
  for (const l of [...mine].reverse()) {
    if (l.added) {
      d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM asset_versions WHERE id = ?)").run(l.prev.current, l.assetId, l.prev.current);
      await deleteVersions([l.added]);
    }
    d.prepare("UPDATE assets SET blur = ? WHERE id = ?").run(l.prev.blur, l.assetId);
    d.prepare(`UPDATE asset_versions SET full_sha256 = ?${l.action === "self" ? ", blurred_of = NULL" : ""} WHERE id = ?`).run(l.prev.full_sha256, l.versionId);
  }
  const rest = lines.filter((l) => l.libraryId !== libraryId).map((l) => JSON.stringify(l) + "\n").join("");
  await mkdir(path.dirname(logFile()), { recursive: true, mode: 0o700 });
  await writeFile(`${logFile()}.tmp`, rest);
  await rename(`${logFile()}.tmp`, logFile());
  if (mine.length) emitEvent("library.changed", {});
  return mine.length;
}

export const reconnectRoutes = new Hono<{ Variables: AuthVars }>();

reconnectRoutes.post("/", async (c) => {
  const b = checkRows(await c.req.json().catch(() => null));
  if (typeof b === "string") return c.json({ error: b }, 400);
  const user = c.get("user").username;
  if (!mayKeepAsFilmed(user, b.libraryId)) return c.json({ error: "Not found" }, 404);
  const rows: Outcome[] = [];
  // the library's own account records the copy, as Face Blur's job does (its Mac, its trust)
  const owner = libraryAccount(b.libraryId) ?? user;
  for (const [i, r] of b.rows.entries()) rows.push(await one(b.libraryId, owner, r, i, b.dry));
  if (!b.dry) emitEvent("library.changed", {});
  return c.json({ rows });
});

reconnectRoutes.delete("/", async (c) => {
  const libraryId = c.req.query("libraryId") ?? "";
  if (!libraryId || !mayKeepAsFilmed(c.get("user").username, libraryId)) return c.json({ error: "Not found" }, 404);
  return c.json({ undone: await undoReconnect(libraryId) });
});
