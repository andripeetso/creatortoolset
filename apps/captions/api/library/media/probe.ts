import { open } from "node:fs/promises";
import { blobs, libraryDb } from "../db";
import { spawnKillable } from "./run";

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
  capturedAt?: number; // ms, from the container's creation_time (a photo's EXIF DateTimeOriginal)
  /** minutes east of UTC where it was filmed, when the file says (an iPhone's creation date, a photo's EXIF offset) */
  tz?: number;
  /** a photo's EXIF names the camera that made it (make or model): footage, never a graphic (shoots.ts isGraphic). Set by every probe of a file's own header */
  camera?: boolean;
  timecode?: string; // start timecode "HH:MM:SS:FF" (";" before FF for drop frame), when the file carries one
  cover?: true; // the only picture is a cover (a song's album art): a still for the thumbnail, not video to describe
  song?: true; // sound only or under a cover, tagged with an artist or an album: a released track, not someone talking
  /** ISO 3166-1 alpha-2 of where it was filmed, from the file's own location; "" when it has none or it is at sea. Never the coordinates */
  country?: string;
  /** the library's own turn on top of `rotation` (the AI's or the person's, api/library/turn.ts); never read from the file */
  turn?: number;
}

const TIMECODE = /^\d\d:\d\d:\d\d[:;]\d\d$/;

type Json = Record<string, any>;

const rate = (r: unknown) => {
  const [a, b] = String(r ?? "").split("/").map(Number);
  const fps = b ? a / b : a;
  return Number.isFinite(fps) && fps >= 1 && fps <= 240 ? Math.round(fps * 1000) / 1000 : 0;
};

export function parseProbe(json: { format?: Json; streams?: Json[]; stream_groups?: Json[] }): ProbeSummary {
  const pictures = json.streams?.filter((s) => s.codec_type === "video") ?? [];
  const isCover = (s: Json) => s.disposition?.attached_pic === 1;
  const v = pictures.find((s) => !isCover(s)) ?? pictures[0];
  const a = json.streams?.find((s) => s.codec_type === "audio");
  // an iPhone HEIC is a grid of 512 px tiles, each its own stream: the photo's size is the grid's
  const grids = json.stream_groups?.filter((g) => g.type === "Tile Grid") ?? [];
  const grid = (grids.find((g) => g.disposition?.default === 1) ?? grids[0])?.components?.[0];
  // Clockwise degrees to show the picture upright. ffmpeg 7 writes the display matrix as side data, where
  // rotation is the negative of that; older builds wrote a `rotate` tag already clockwise. Read both, copy neither.
  const matrix = v?.side_data_list?.find((d: Json) => d.rotation !== undefined)?.rotation;
  const turn = matrix !== undefined ? -Number(matrix) : Number(v?.tags?.rotate ?? 0);
  // an iPhone's (or a pair of glasses') own filming date ("2026-11-12T14:03:22-0600"); creation_time is when the file was
  // written, which for an edited, exported or sent clip is days later. creation_time only when the file has no other
  const filmedTag = String(json.format?.tags?.["com.apple.quicktime.creationdate"] ?? "");
  const capturedAt = Date.parse(filmedTag.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) || Date.parse(json.format?.tags?.creation_time ?? "");
  const tz = offsetOf(/[+-]\d\d:?\d\d$/.exec(filmedTag)?.[0]);
  // only a string in the strict timecode shape is kept, never the tag object
  const timecode = [v?.tags?.timecode, json.format?.tags?.timecode, ...(json.streams ?? []).map((s) => s.tags?.timecode)].find(
    (t) => typeof t === "string" && TIMECODE.test(t),
  ) as string | undefined;
  return {
    duration: Number(json.format?.duration) || 0,
    width: Number(grid?.width ?? v?.width) || 0,
    height: Number(grid?.height ?? v?.height) || 0,
    fps: v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) : 0,
    rotation: ((Math.round(turn) % 360) + 360) % 360,
    format: json.format?.format_name ?? "",
    vcodec: String(v?.codec_name ?? ""),
    pixFmt: String(v?.pix_fmt ?? ""),
    acodec: String(a?.codec_name ?? ""),
    ...(Number.isFinite(capturedAt) ? { capturedAt } : {}),
    ...(tz !== undefined ? { tz } : {}),
    ...(timecode ? { timecode } : {}),
    ...(v && isCover(v) ? { cover: true as const } : {}),
    ...(a && (!v || isCover(v)) && Object.keys(json.format?.tags ?? {}).some((k) => /^(artist|album)$/i.test(k)) ? { song: true as const } : {}),
  };
}

// how a downloaded song or music video is named ("... (Official Music Video)", "(Lyrics)", "Visualizer", "feat. X")
const SONG_TITLE = /\bofficial (music )?video\b|\bofficial audio\b|\blyric video\b|[([](official )?(audio|lyrics?)[)\]]|\bvisuali[sz]er\b|\b(feat|ft)\. /i;

/** A song, by its file's tags or its name: music, so it gets no transcript, description or duplicate check (worker.ts). */
export const looksLikeSong = (title: string, p: ProbeSummary) => !!p.song || SONG_TITLE.test(title);

/** Probes a file with ffprobe, and where it was filmed. Rejects when ffprobe fails or the file is not media. */
export async function probe(file: string): Promise<ProbeSummary> {
  // stream groups (a HEIC's tile grid) need ffprobe 7.1; an older one on PATH refuses the option and is asked without it
  const json = await ffprobe(file, ["-show_format", "-show_streams", "-show_stream_groups"]).catch(() => ffprobe(file, ["-show_format", "-show_streams"]));
  const p = parseProbe(json);
  const exif = await photoExif(file);
  return {
    ...p,
    ...(p.capturedAt === undefined && exif.takenAt !== undefined ? { capturedAt: exif.takenAt, ...(exif.tz !== undefined ? { tz: exif.tz } : {}) } : {}),
    camera: exif.camera,
    country: (await countryOf(json)) || exif.country,
  };
}

/** Minutes east of UTC from "+HH:MM", "-HHMM"; undefined when it is not one. */
export function offsetOf(s: string | undefined): number | undefined {
  const m = /^([+-])(\d\d):?(\d\d)$/.exec(s?.trim() ?? "");
  const min = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : NaN;
  return Math.abs(min) <= 14 * 60 ? min : undefined;
}

/** Whether `file` has a sound track; true when ffprobe can't say, so the file is treated as it was before the check. */
export const hasSound = (file: string): Promise<boolean> =>
  ffprobe(file, ["-show_streams", "-select_streams", "a"]).then(
    (j) => !!j.streams?.length,
    () => true,
  );

export function ffprobe(file: string, args: string[]): Promise<{ format?: Json; streams?: Json[]; stream_groups?: Json[] }> {
  return new Promise((resolve, reject) => {
    const p = spawnKillable("ffprobe", ["-v", "error", ...args, "-of", "json", file]);
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

/** How much of a photo's start is read for its EXIF: a JPEG's is at the top, an iPhone HEIC's ~95 KB in (after its thumbnail). */
const EXIF_HEAD = 512 * 1024;

/** What a photo's EXIF says (JPEG, HEIC): the country it was taken in ("" when it has no GPS), whether a camera made it, when. */
export interface PhotoExif {
  country: string;
  camera: boolean;
  takenAt?: number;
  tz?: number;
}

/**
 * A photo's EXIF; nothing found when it has none. ffprobe shows no EXIF. The coordinates stay in here.
 * ponytail: looks for the TIFF block in the file's first 512 KB instead of following HEIC's item locations; walk `iloc` if a camera puts it further in
 */
export async function photoExif(file: string): Promise<PhotoExif> {
  const none: PhotoExif = { country: "", camera: false };
  const f = await open(file, "r").catch(() => null);
  if (!f) return none;
  const head = Buffer.alloc(EXIF_HEAD);
  const { bytesRead } = await f.read(head, 0, EXIF_HEAD, 0).finally(() => f.close());
  const b = head.subarray(0, bytesRead);
  for (const sig of [Buffer.from("MM\0*"), Buffer.from("II*\0")]) {
    for (let at = b.indexOf(sig); at >= 0; at = b.indexOf(sig, at + 1)) {
      const x = exifOf(b, at);
      if (x && (x.gps || x.camera || x.takenAt !== undefined))
        return { country: x.gps ? await countryAt(x.gps[0], x.gps[1]) : "", camera: x.camera, ...(x.takenAt !== undefined ? { takenAt: x.takenAt } : {}), ...(x.tz !== undefined ? { tz: x.tz } : {}) };
    }
  }
  return none;
}

/** The TIFF block at `t`: its GPS, whether it names a camera (make or model), when it was taken (DateTimeOriginal); null when it is not one. */
function exifOf(b: Buffer, t: number): { gps: [number, number] | null; camera: boolean; takenAt?: number; tz?: number } | null {
  const le = b[t] === 0x49;
  const u16 = (o: number) => (le ? b.readUInt16LE(t + o) : b.readUInt16BE(t + o));
  const u32 = (o: number) => (le ? b.readUInt32LE(t + o) : b.readUInt32BE(t + o));
  const fits = (o: number, n: number) => o >= 0 && t + o + n <= b.length;
  const entries = (ifd: number) => {
    if (!fits(ifd, 2)) return [];
    return Array.from({ length: u16(ifd) }, (_, i) => ifd + 2 + i * 12).filter((e) => fits(e, 12)).map((e) => ({ tag: u16(e), count: u32(e + 4), value: e + 8 }));
  };
  // an ASCII value: in the entry when it fits in 4 bytes, else at its offset
  const ascii = (e: { count: number; value: number } | undefined) => {
    if (!e || e.count > 64) return "";
    const o = e.count <= 4 ? e.value : u32(e.value);
    return fits(o, e.count) ? b.subarray(t + o, t + o + e.count).toString("latin1").replace(/\0.*$/s, "").trim() : "";
  };
  if (!fits(0, 8)) return null;
  const top = entries(u32(4));
  const camera = top.some((e) => (e.tag === 0x010f || e.tag === 0x0110) && ascii(e) !== "");
  const exif = top.find((e) => e.tag === 0x8769);
  const sub = exif ? entries(u32(exif.value)) : [];
  // "2026:11:12 14:03:22", the camera's own clock; with OffsetTimeOriginal ("-06:00") it is a moment, else this server's time zone reads it
  const when = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(ascii(sub.find((e) => e.tag === 0x9003)));
  const tz = offsetOf(ascii(sub.find((e) => e.tag === 0x9011)));
  const [y, mo, d, h, mi, s] = when ? when.slice(1).map(Number) : [];
  const local = when ? Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) : NaN;
  const takenAt = !Number.isFinite(local) || y! < 1990 ? undefined : tz !== undefined ? local - tz * 60_000 : new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime();
  const gps = (): [number, number] | null => {
    const at = top.find((e) => e.tag === 0x8825);
    if (!at) return null;
    const tags = new Map(entries(u32(at.value)).map((e) => [e.tag, e.value]));
    const angle = (tag: number) => {
      const v = tags.get(tag);
      const o = v === undefined ? -1 : u32(v);
      if (!fits(o, 24)) return NaN;
      const [dd, m, ss] = [0, 1, 2].map((i) => u32(o + i * 8) / u32(o + i * 8 + 4));
      return dd! + m! / 60 + ss! / 3600;
    };
    const ref = (tag: number) => (tags.has(tag) ? String.fromCharCode(b[t + tags.get(tag)!]!) : "");
    const lat = angle(2) * (ref(1) === "S" ? -1 : 1);
    const lon = angle(4) * (ref(3) === "W" ? -1 : 1);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
  };
  return { gps: gps(), camera, ...(takenAt !== undefined ? { takenAt, ...(tz !== undefined ? { tz } : {}) } : {}) };
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
 * Clips probed before the country was kept get it once, from their location tag (a photo's EXIF) alone. Only files on this server's
 * own disk (a bucket's would be downloaded whole); a file that is gone is left for the next start.
 */
export async function placeUnplaced(db = libraryDb()): Promise<number> {
  let n = 0;
  let after = "";
  const touched = new Set<string>();
  try {
    for (;;) {
      const rows = db
        .prepare(
          `SELECT v.id, v.source_key, a.library_id FROM asset_versions v JOIN assets a ON a.current_version_id = v.id JOIN libraries l ON l.id = a.library_id
           WHERE l.storage_kind = 'local' AND a.kind IN ('video', 'image') AND v.probe IS NOT NULL AND json_type(v.probe, '$.country') IS NULL
           AND v.id > ? ORDER BY v.id LIMIT 100`,
        )
        .all(after) as { id: string; source_key: string; library_id: string }[];
      if (!rows.length) break;
      for (const r of rows) {
        const file = await blobs.localCopy(r.source_key).catch(() => null);
        const json = file && (await ffprobe(file, ["-show_entries", `format_tags=${LOCATION_TAGS.join(",")}`]).catch(() => null));
        if (!json) continue;
        db.prepare("UPDATE asset_versions SET probe = json_set(probe, '$.country', ?) WHERE id = ?").run((await countryOf(json)) || (await photoExif(file)).country, r.id);
        touched.add(r.library_id);
        n++;
      }
      after = rows[rows.length - 1]!.id;
    }
  } catch (e) {
    console.error("[library] place:", e);
  }
  const { libraryChanged } = await import("../access"); // the open pages' Where list refetches
  for (const id of touched) libraryChanged(id);
  return n;
}
