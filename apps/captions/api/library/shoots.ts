import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProbeSummary } from "./media/probe";

/**
 * Smart folders by shoot (MEDIA LIBRARY CEO 11-19, after a "Driving" folder swallowed 92 clips of one vlog): in a library
 * the AI organizes, a clip or a camera photo goes into the folder of its shoot, never one named by topic. A shoot is
 * the clips filmed close together in time (less than SHOOT_GAP_MS between one and the next) in one place: the country
 * the file's own location gives (the coordinates are never kept, media/probe.ts), and a clip with none joins any. The
 * folder is named "<day> · <place>": the place the AI reads off the clip when it names a town or a venue (describe.ts),
 * else the country. Topics stay tags. Nothing here calls an AI, so a clip is filed as soon as it is probed.
 */

/** Two clips this far apart in time are two shoots (a night between days, a morning and an evening shoot). */
export const SHOOT_GAP_MS = 6 * 3600_000;

export interface Asset {
  id: string;
  library_id: string;
  kind: string;
  created_by: string;
}

interface Shoot {
  /** "12 Nov", or "12 Nov 2025" in another year */
  label: string;
  country: string;
  /** the place the AI read off one of its clips; "" until then */
  place: string;
  /** the name it was given: a folder named otherwise was renamed by the person, and keeps their name */
  name: string;
}

/**
 * When a version was filmed: its file's capture time, else the earliest modified time a computer reported for it, else
 * when it was added (FILE_DATE is the same without that last step). A time before 1990 is a camera's unset clock (1904, 1970), never a date.
 */
export const FILE_DATE = `COALESCE((SELECT t FROM (SELECT json_extract(v.probe, '$.capturedAt') AS t) WHERE t > 631152000000), (SELECT MIN(p.mtime) FROM version_places p WHERE p.version_id = v.id AND p.mtime > 631152000000))`;
export const FILMED = `COALESCE(${FILE_DATE}, a.created_at)`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Nov" where it was filmed (its own offset when the file says, else this server's time zone), with the year when it is not this one. */
export function dayLabel(at: number, tz?: number | null, now = Date.now()): string {
  const d = new Date(tz == null ? at : at + tz * 60_000);
  const [day, month, year] = tz == null ? [d.getDate(), d.getMonth(), d.getFullYear()] : [d.getUTCDate(), d.getUTCMonth(), d.getUTCFullYear()];
  return `${day} ${MONTHS[month]}${year === new Date(now).getFullYear() ? "" : ` ${year}`}`;
}

const regions = new Intl.DisplayNames(["en"], { type: "region" });
/** A country's English name from its ISO code; "" for none. */
export const countryName = (code: string): string => {
  try {
    return code ? (regions.of(code.toUpperCase()) ?? "") : "";
  } catch {
    return "";
  }
};

const nameOf = (s: Pick<Shoot, "label" | "country" | "place">) => {
  const place = s.place || countryName(s.country);
  return place ? `${s.label} · ${place}` : s.label;
};

/** A photo that is a graphic (a logo, a screenshot, an export), not footage: transparent, or made by no camera. */
export function isGraphic(p: Pick<ProbeSummary, "pixFmt" | "camera"> | null, file?: string | null): boolean {
  // a phone's or a pair of glasses' own format: footage, whatever the EXIF the probe could reach
  if (file && /\.(heic|heif)$/i.test(file)) return false;
  const alpha = /^(rgba|bgra|argb|abgr|ya\d|gbrap|yuva)/.test(p?.pixFmt ?? "");
  if (p?.camera === true) return alpha;
  if (p?.camera === false) return true;
  // a Mac that sent nothing about the camera (an app before 11-19): by its file type
  return alpha || !/\.(jpe?g|dng|cr[23]|nef|arw|raf|orf|rw2)$/i.test(file ?? "");
}

const folderId = () => `col_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * Puts the asset in its shoot's folder: the one a clip filmed within SHOOT_GAP_MS of it, in no other country, is in,
 * else a new one. The folder is plain (no rule: Smart folders' own judge never refiles it). False for an asset it can't read.
 */
export function fileShoot(d: DatabaseSync, a: Asset): boolean {
  const me = d
    .prepare(`SELECT ${FILMED} AS at, CASE WHEN json_extract(v.probe, '$.capturedAt') > 631152000000 THEN json_extract(v.probe, '$.tz') END AS tz, COALESCE(json_extract(v.probe, '$.country'), '') AS country FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ?`)
    .get(a.id) as { at: number; tz: number | null; country: string } | undefined;
  if (!me) return false;
  // the nearest clip in time already in a shoot of no other country (ponytail: reads every shoot clip of the library per
  // file; an index on the filmed time if libraries pass ~50k clips)
  const near = d
    .prepare(
      `SELECT c.id, c.name, c.shoot FROM collections c JOIN collection_items i ON i.collection_id = c.id JOIN assets a ON a.id = i.asset_id JOIN asset_versions v ON v.id = a.current_version_id
       WHERE c.library_id = ? AND c.shoot IS NOT NULL AND a.id <> ? AND a.trashed_at IS NULL
         AND (? = '' OR json_extract(c.shoot, '$.country') IN ('', ?))
         AND ABS(${FILMED} - ?) < ?
       ORDER BY ABS(${FILMED} - ?) LIMIT 1`,
    )
    .get(a.library_id, a.id, me.country, me.country, me.at, SHOOT_GAP_MS, me.at) as { id: string; name: string; shoot: string } | undefined;
  const folder = near?.id ?? newShoot(d, a, { label: dayLabel(me.at, me.tz), country: me.country, place: "" });
  // a shoot begun by a clip with no location takes the first country one of its clips has
  const s = near && (JSON.parse(near.shoot) as Shoot);
  if (s && near && !s.country && me.country) rename(d, a.library_id, near.id, near.name, { ...s, country: me.country });
  // the app's filing (by_ai, as smart.ts files): the one reshoot may move; one the person puts in by hand is theirs
  d.prepare(
    `INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by, by_ai)
     SELECT ?, ?, COALESCE(MAX(position), 0) + 1, 'ai', 1 FROM collection_items WHERE collection_id = ?`,
  ).run(folder, a.id, folder);
  return true;
}

/**
 * A clip whose filming date or place became known after it was filed (a computer read it later: report.ts
 * filmedForDevice): it leaves the shoot the app filed it in and goes into the one it belongs to. Only the app's own
 * filings move; a clip the person put somewhere stays. A shoot folder left empty goes, unless the person renamed it.
 */
export function reshoot(d: DatabaseSync, a: Asset): boolean {
  const filed = d
    .prepare("SELECT c.id, c.name, c.shoot FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = ? AND c.shoot IS NOT NULL AND i.by_ai = 1")
    .all(a.id) as { id: string; name: string; shoot: string }[];
  if (!filed.length) return false;
  for (const f of filed) {
    d.prepare("DELETE FROM collection_items WHERE collection_id = ? AND asset_id = ?").run(f.id, a.id);
    // left empty, and never touched by the person (renamed, a folder inside, shared): it goes
    const theirs = d.prepare(
      "SELECT 1 FROM collection_items WHERE collection_id = ? UNION ALL SELECT 1 FROM collections WHERE parent_id = ? UNION ALL SELECT 1 FROM library_grants WHERE collection_id = ?",
    ).get(f.id, f.id, f.id);
    if (!theirs && f.name === (JSON.parse(f.shoot) as Shoot).name) {
      d.prepare("DELETE FROM folder_out WHERE collection_id = ?").run(f.id);
      d.prepare("DELETE FROM collections WHERE id = ?").run(f.id);
    }
  }
  return fileShoot(d, a);
}

/** A name no other top-level folder of the library has: "12 Nov · Costa Rica", then "… 2". */
function freeName(d: DatabaseSync, libraryId: string, name: string, except = ""): string {
  const taken = (n: string) => !!d.prepare("SELECT 1 FROM collections WHERE library_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE AND id <> ?").get(libraryId, n, except);
  let out = name;
  for (let k = 2; taken(out); k++) out = `${name} ${k}`;
  return out;
}

function newShoot(d: DatabaseSync, a: Asset, s: Omit<Shoot, "name">): string {
  const id = folderId();
  const name = freeName(d, a.library_id, nameOf(s));
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at, created_by, shoot) VALUES (?, ?, NULL, ?, 'manual', ?, ?, ?)").run(
    id,
    a.library_id,
    name,
    Date.now(),
    a.created_by,
    JSON.stringify({ ...s, name } satisfies Shoot),
  );
  return id;
}

/**
 * A file indexed on a Mac that is this very machine (the Mac app's own server): what its header says of when, where and
 * by what it was filmed goes into the version's probe, as a probe here would have read it (a Mac app before 11-19 sends
 * none of it). Its `camera` says it was read. False when the file isn't here or can't be read.
 */
export async function readHere(d: DatabaseSync, versionId: string, file: string, kind: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  if (!(await stat(file).catch(() => null))?.isFile()) return false;
  const { probe } = await import("./media/probe");
  const p = await probe(file).catch(() => null);
  if (!p) return false;
  const add = {
    ...(p.capturedAt !== undefined ? { capturedAt: p.capturedAt } : {}),
    ...(p.tz !== undefined ? { tz: p.tz } : {}),
    ...(p.country ? { country: p.country } : {}),
    camera: !!p.camera,
    // a picture's alpha (isGraphic); a video keeps the Mac's own probe
    ...(kind === "image" ? { pixFmt: p.pixFmt } : {}),
  };
  d.prepare("UPDATE asset_versions SET probe = json_patch(COALESCE(probe, '{}'), ?) WHERE id = ?").run(JSON.stringify(add), versionId);
  return true;
}

/** A place the AI read: a name (a town, a beach, a venue), one to four words; anything else is none. */
export function placeOf(v: unknown): string {
  if (typeof v !== "string") return "";
  const p = v.replace(/\s+/g, " ").trim();
  return p.length <= 40 && p.split(" ").length <= 4 && /^\p{Lu}[\p{L}\p{N} '.&-]*$/u.test(p) ? p : "";
}

/**
 * The AI read where a version's clip was filmed (describe.ts): its shoot folder takes that place in its name, when it
 * has none yet and the person has not renamed it. The first place read for a shoot is the one it keeps.
 */
export function nameShoot(d: DatabaseSync, versionId: string, place: string): void {
  if (!(place = placeOf(place))) return;
  const rows = d
    .prepare("SELECT c.id, c.library_id, c.name, c.shoot FROM collections c JOIN collection_items i ON i.collection_id = c.id JOIN asset_versions v ON v.asset_id = i.asset_id WHERE v.id = ? AND c.shoot IS NOT NULL")
    .all(versionId) as { id: string; library_id: string; name: string; shoot: string }[];
  for (const r of rows) {
    const s = JSON.parse(r.shoot) as Shoot;
    if (!s.place) rename(d, r.library_id, r.id, r.name, { ...s, place });
  }
}

/** The shoot's folder gets the name `s` gives it, unless the person renamed it (then only what the app knows changes). */
function rename(d: DatabaseSync, libraryId: string, id: string, name: string, s: Shoot): void {
  const next = name === s.name ? freeName(d, libraryId, nameOf(s), id) : name;
  d.prepare("UPDATE collections SET name = ?, shoot = ? WHERE id = ?").run(next, JSON.stringify({ ...s, name: name === s.name ? next : s.name } satisfies Shoot), id);
}
