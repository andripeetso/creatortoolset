import { spawn } from "node:child_process";
import { blobs, libraryDb } from "../db";

/**
 * What the library keeps of a file's probe (tasks/media-library-plan.md, section 5). Built field by field from
 * ffprobe's output: the container's and streams' `tags` objects are never copied, so GPS and other metadata
 * cannot reach the database.
 */
export interface ProbeSummary {
  duration: number; // seconds
  width: number;
  height: number;
  fps: number;
  rotation: number; // 0 | 90 | 180 | 270, clockwise
  format: string;
  vcodec: string;
  pixFmt: string;
  acodec: string;
  capturedAt?: number; // ms, from the container's creation_time
  timecode?: string; // start timecode "HH:MM:SS:FF" (";" before FF for drop frame), when the file carries one
  cover?: true; // the only picture is a cover (a song's album art): a still for the thumbnail, not video to describe
  /** ISO 3166-1 alpha-2 of where it was filmed, from the file's own location; "" when it has none or it is at sea. Never the coordinates */
  country?: string;
}

const TIMECODE = /^\d\d:\d\d:\d\d[:;]\d\d$/;

type Json = Record<string, any>;

const rate = (r: unknown) => {
  const [a, b] = String(r ?? "").split("/").map(Number);
  const fps = b ? a / b : a;
  return Number.isFinite(fps) && fps >= 1 && fps <= 240 ? Math.round(fps * 1000) / 1000 : 0;
};

export function parseProbe(json: { format?: Json; streams?: Json[] }): ProbeSummary {
  const pictures = json.streams?.filter((s) => s.codec_type === "video") ?? [];
  const isCover = (s: Json) => s.disposition?.attached_pic === 1;
  const v = pictures.find((s) => !isCover(s)) ?? pictures[0];
  const a = json.streams?.find((s) => s.codec_type === "audio");
  // Clockwise degrees to show the picture upright. ffmpeg 7 writes the display matrix as side data, where
  // rotation is the negative of that; older builds wrote a `rotate` tag already clockwise. Read both, copy neither.
  const matrix = v?.side_data_list?.find((d: Json) => d.rotation !== undefined)?.rotation;
  const turn = matrix !== undefined ? -Number(matrix) : Number(v?.tags?.rotate ?? 0);
  const capturedAt = Date.parse(json.format?.tags?.creation_time ?? "");
  // only a string in the strict timecode shape is kept, never the tag object
  const timecode = [v?.tags?.timecode, json.format?.tags?.timecode, ...(json.streams ?? []).map((s) => s.tags?.timecode)].find(
    (t) => typeof t === "string" && TIMECODE.test(t),
  ) as string | undefined;
  return {
    duration: Number(json.format?.duration) || 0,
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
    fps: v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) : 0,
    rotation: ((Math.round(turn) % 360) + 360) % 360,
    format: json.format?.format_name ?? "",
    vcodec: String(v?.codec_name ?? ""),
    pixFmt: String(v?.pix_fmt ?? ""),
    acodec: String(a?.codec_name ?? ""),
    ...(Number.isFinite(capturedAt) ? { capturedAt } : {}),
    ...(timecode ? { timecode } : {}),
    ...(v && isCover(v) ? { cover: true as const } : {}),
  };
}

/** Probes a file with ffprobe, and where it was filmed. Rejects when ffprobe fails or the file is not media. */
export async function probe(file: string): Promise<ProbeSummary> {
  const json = await ffprobe(file, ["-show_format", "-show_streams"]);
  return { ...parseProbe(json), country: await countryOf(json) };
}

function ffprobe(file: string, args: string[]): Promise<{ format?: Json; streams?: Json[] }> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", ...args, "-of", "json", file]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffprobe exited ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Plays in every current browser without a proxy (copied from review.ts's browserPlayable; S9 can share it). */
export function browserPlayable(p: Pick<ProbeSummary, "format" | "vcodec" | "pixFmt" | "acodec">): boolean {
  const audioOk = !p.acodec || ["aac", "mp3", "opus", "vorbis"].includes(p.acodec);
  const pixOk = !p.vcodec || ["yuv420p", "yuvj420p"].includes(p.pixFmt);
  const mp4 = p.format.includes("mp4") && ["h264", "av1", ""].includes(p.vcodec);
  const webm = p.format.includes("webm") && ["vp8", "vp9", "av1"].includes(p.vcodec);
  return audioOk && pixOk && (mp4 || webm);
}

/** The file's own location as ISO 6709 ("+59.4370+024.7536+012.3/"): latitude then longitude, decimal degrees. */
const ISO6709 = /^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/;
const LOCATION_TAGS = ["com.apple.quicktime.location.ISO6709", "location", "location-eng"];

/** The country a file was filmed in, from its location tag; "" when it has none. The coordinates stay in here. */
export async function countryOf(json: { format?: Json }): Promise<string> {
  const tag = LOCATION_TAGS.map((k) => json.format?.tags?.[k]).find((v) => typeof v === "string");
  const m = typeof tag === "string" ? ISO6709.exec(tag.trim()) : null;
  const [lat, lon] = m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? countryAt(lat, lon) : "";
}

type Country = [code: string, box: [west: number, south: number, east: number, north: number], polygons: number[][][]];
let borders: Country[] | null = null;
/** How far off a border a point still counts for the nearest country, degrees (~5 km): a beach, a harbour, a boat. */
const NEAR = 0.05;

/** The country (ISO 3166-1 alpha-2) at a point, offline (countries.ts, loaded on first use); "" out at sea. */
export async function countryAt(lat: number, lon: number): Promise<string> {
  borders ??= JSON.parse((await import("./countries")).default) as Country[];
  // even-odd over a polygon's rings: inside the outer ring and in none of its holes
  const crossings = (ring: number[]) => {
    let c = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const near = (c: Country, by: number) => lon >= c[1][0] - by && lon <= c[1][2] + by && lat >= c[1][1] - by && lat <= c[1][3] + by;
  // inside two (a small country the outlines don't cut out of its neighbour, the Vatican in Italy): the smaller one
  const area = (c: Country) => (c[1][2] - c[1][0]) * (c[1][3] - c[1][1]);
  const hit = borders.filter((c) => near(c, 0) && c[2].some((rings) => rings.filter(crossings).length % 2 === 1)).sort((a, b) => area(a) - area(b))[0];
  if (hit) return hit[0];
  // just off a simplified coast: the nearest border within NEAR, longitude scaled to the latitude
  const k = Math.cos((lat * Math.PI) / 180);
  let best = { code: "", d: NEAR };
  for (const c of borders) {
    if (!near(c, NEAR)) continue;
    for (const ring of c[2].flat())
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const [ax, ay, bx, by] = [(ring[i]! - lon) * k, ring[i + 1]! - lat, (ring[i + 2]! - lon) * k, ring[i + 3]! - lat];
        const t = Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
        const d = Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
        if (d < best.d) best = { code: c[0], d };
      }
  }
  return best.code;
}

/**
 * Clips probed before the country was kept get it once, from their location tag alone. Only files on this server's
 * own disk (a bucket's would be downloaded whole); a file that is gone is left for the next start.
 */
export async function placeUnplaced(db = libraryDb()): Promise<number> {
  let n = 0;
  let after = "";
  try {
    for (;;) {
      const rows = db
        .prepare(
          `SELECT v.id, v.source_key FROM asset_versions v JOIN assets a ON a.current_version_id = v.id JOIN libraries l ON l.id = a.library_id
           WHERE l.storage_kind = 'local' AND a.kind IN ('video', 'image') AND v.probe IS NOT NULL AND json_type(v.probe, '$.country') IS NULL
           AND v.id > ? ORDER BY v.id LIMIT 100`,
        )
        .all(after) as { id: string; source_key: string }[];
      if (!rows.length) return n;
      for (const r of rows) {
        const file = await blobs.localCopy(r.source_key).catch(() => null);
        const json = file && (await ffprobe(file, ["-show_entries", `format_tags=${LOCATION_TAGS.join(",")}`]).catch(() => null));
        if (!json) continue;
        db.prepare("UPDATE asset_versions SET probe = json_set(probe, '$.country', ?) WHERE id = ?").run(await countryOf(json), r.id);
        n++;
      }
      after = rows[rows.length - 1]!.id;
    }
  } catch (e) {
    console.error("[library] place:", e);
    return n;
  }
}
