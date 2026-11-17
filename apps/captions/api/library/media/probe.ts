import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
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
  const capturedAt = Date.parse(json.format?.tags?.creation_time ?? "");
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
  return { ...parseProbe(json), country: (await countryOf(json)) || (await photoCountry(file)) };
}

/** Whether `file` has a sound track; true when ffprobe can't say, so the file is treated as it was before the check. */
export const hasSound = (file: string): Promise<boolean> =>
  ffprobe(file, ["-show_streams", "-select_streams", "a"]).then(
    (j) => !!j.streams?.length,
    () => true,
  );

function ffprobe(file: string, args: string[]): Promise<{ format?: Json; streams?: Json[]; stream_groups?: Json[] }> {
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

/** How much of a photo's start is read for its EXIF: a JPEG's is at the top, an iPhone HEIC's ~95 KB in (after its thumbnail). */
const EXIF_HEAD = 512 * 1024;

/**
 * The country a photo was taken in, from its EXIF GPS (JPEG, HEIC); "" when it has none. ffprobe shows no EXIF.
 * ponytail: looks for the TIFF block in the file's first 512 KB instead of following HEIC's item locations; walk `iloc` if a camera puts it further in
 */
export async function photoCountry(file: string): Promise<string> {
  const f = await open(file, "r").catch(() => null);
  if (!f) return "";
  const head = Buffer.alloc(EXIF_HEAD);
  const { bytesRead } = await f.read(head, 0, EXIF_HEAD, 0).finally(() => f.close());
  const b = head.subarray(0, bytesRead);
  for (const sig of [Buffer.from("MM\0*"), Buffer.from("II*\0")]) {
    for (let at = b.indexOf(sig); at >= 0; at = b.indexOf(sig, at + 1)) {
      const at2 = exifGps(b, at);
      if (at2) return countryAt(at2[0], at2[1]);
    }
  }
  return "";
}

/** Latitude and longitude from the TIFF block at `t`, or null when it is not one or has no GPS. */
export function exifGps(b: Buffer, t: number): [number, number] | null {
  const le = b[t] === 0x49;
  const u16 = (o: number) => (le ? b.readUInt16LE(t + o) : b.readUInt16BE(t + o));
  const u32 = (o: number) => (le ? b.readUInt32LE(t + o) : b.readUInt32BE(t + o));
  const fits = (o: number, n: number) => o >= 0 && t + o + n <= b.length;
  const entries = (ifd: number) => {
    if (!fits(ifd, 2)) return [];
    return Array.from({ length: u16(ifd) }, (_, i) => ifd + 2 + i * 12).filter((e) => fits(e, 12)).map((e) => ({ tag: u16(e), value: e + 8 }));
  };
  if (!fits(0, 8)) return null;
  const gps = entries(u32(4)).find((e) => e.tag === 0x8825);
  if (!gps) return null;
  const tags = new Map(entries(u32(gps.value)).map((e) => [e.tag, e.value]));
  const angle = (tag: number) => {
    const at = tags.get(tag);
    const o = at === undefined ? -1 : u32(at);
    if (!fits(o, 24)) return NaN;
    const [d, m, s] = [0, 1, 2].map((i) => u32(o + i * 8) / u32(o + i * 8 + 4));
    return d! + m! / 60 + s! / 3600;
  };
  const ref = (tag: number) => (tags.has(tag) ? String.fromCharCode(b[t + tags.get(tag)!]!) : "");
  const lat = angle(2) * (ref(1) === "S" ? -1 : 1);
  const lon = angle(4) * (ref(3) === "W" ? -1 : 1);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
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
        db.prepare("UPDATE asset_versions SET probe = json_set(probe, '$.country', ?) WHERE id = ?").run((await countryOf(json)) || (await photoCountry(file)), r.id);
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
