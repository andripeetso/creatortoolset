import { hostsOriginals, hostsProxies, PICTURE_FILE, SPRITE_FRAMES, SPRITE_SIDE, type LibraryUpload } from "@contracts/library";
import { importHash, importThumb, macMediaUrl, thisMacBridge } from "@/lib/thisMac";

/**
 * A file indexed where it is on this Mac, for a server that is not on it (api/library/on-mac.ts). The Mac app's window
 * reads the file itself (a dropped or picked file is a File the page may read): its length and size, a card picture,
 * the hover strip and four stills for the AI's description. Only those go to the server; the video never does.
 */

/** Frames for the AI's description (api/library/describe.ts FRAMES), each the middle of its quarter. */
const STILLS = 4;
const MIB = 1024 * 1024;

/** The duplicate check's fingerprint: SHA-256 over the size, the first MiB and the last MiB (no gigabytes read). */
export async function quickPrint(file: Blob): Promise<string> {
  const head = await file.slice(0, MIB).arrayBuffer();
  const tail = file.size > 2 * MIB ? await file.slice(file.size - MIB).arrayBuffer() : new ArrayBuffer(0);
  const parts = [new TextEncoder().encode(String(file.size)), new Uint8Array(head), new Uint8Array(tail)];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", all))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The second frame `i` of a strip of `n` shows over `duration` (api/library/media/sprite.ts spriteTime). */
export const frameAt = (i: number, n: number, duration: number) => ((i + 0.5) * duration) / n;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const toB64 = (c: HTMLCanvasElement, q = 0.8) =>
  new Promise<string>((ok, no) =>
    c.toBlob((b) => {
      if (!b) return no(new Error("No picture"));
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1] ?? "");
      r.onerror = () => no(r.error);
      r.readAsDataURL(b);
    }, "image/jpeg", q),
  );

/** Draws `src` into a w×h canvas: `cover` crops to fill it (the strip's cells), else it is scaled to `w` wide. */
function draw(src: CanvasImageSource & { videoWidth?: number; naturalWidth?: number }, sw: number, sh: number, w: number, h?: number) {
  const c = document.createElement("canvas");
  const height = h ?? Math.max(2, Math.round((w * sh) / sw / 2) * 2);
  c.width = w;
  c.height = height;
  const g = c.getContext("2d")!;
  if (h) {
    const s = Math.max(w / sw, h / sh);
    g.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
  } else g.drawImage(src, 0, 0, w, height);
  return c;
}

const once = (el: HTMLElement, ok: string, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => (el.removeEventListener(ok, done), el.removeEventListener("error", fail), resolve());
    const fail = () => (el.removeEventListener(ok, done), reject(new Error("Could not read the file")));
    el.addEventListener(ok, done);
    el.addEventListener("error", fail);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/**
 * A file's shape (width / height) from its metadata only, fast and before anything is sent: a picture as decoded, a video
 * as it plays (turned the way it was filmed). null for sound, or when it can't be read in `ms`.
 */
export async function shapeOf(file: File, ms = 5000): Promise<number | null> {
  const url = URL.createObjectURL(file);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error("timed out")), ms);
  try {
    if (file.type.startsWith("image/") || /\.(jpe?g|png|heic|webp|gif|tiff?)$/i.test(file.name)) {
      const img = new Image();
      img.src = url;
      await Promise.race([img.decode(), new Promise((_, no) => stop.signal.addEventListener("abort", no, { once: true }))]);
      return img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null;
    }
    if (file.type.startsWith("audio/") || /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(file.name)) return null;
    const el = document.createElement("video");
    el.muted = true;
    el.preload = "metadata";
    el.src = url;
    await once(el, "loadedmetadata", stop.signal);
    const shape = el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : null;
    el.removeAttribute("src");
    el.load();
    return shape;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
}

export interface MacIndex {
  duration?: number;
  width?: number;
  height?: number;
  thumb?: string;
  sprite?: string;
  frames: string[];
}

/** A file on this Mac read by its address (lib/thisMac.ts macMediaUrl) rather than dropped: a rescan's new file. */
export interface MacFile {
  url: string;
  name: string;
  size: number;
  /** its quickPrint, from the Mac (importPrint) */
  quick: string;
}

/**
 * A picture this window decodes: an <img> first, else createImageBitmap (some HEICs one takes and the other doesn't),
 * else, with its path on this Mac, a thumbnail macOS makes (importThumb: HEIC and RAW the window can't read). Null: none.
 */
async function pictureIndex(file: File | MacFile, url: string, path?: string): Promise<MacIndex | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, thumb: await toB64(draw(img, img.naturalWidth, img.naturalHeight, 480)), frames: [] };
  } catch {
    /* tried below */
  }
  if (file instanceof File && typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      const out = { width: bmp.width, height: bmp.height, thumb: await toB64(draw(bmp, bmp.width, bmp.height, 480)), frames: [] };
      bmp.close();
      return out;
    } catch {
      /* tried below */
    }
  }
  const made = path ? await importThumb(path) : null;
  return made ? { width: made.width, height: made.height, thumb: made.thumb, frames: [] } : null;
}

/**
 * What the server lists `file` by, read here. A file the app can't decode is indexed by its name and size only (a
 * picture with no thumbnail gets one later: repairPictures). `path`: where it is on this Mac, for the Mac's own decode.
 */
export async function readIndex(file: File | MacFile, signal?: AbortSignal, path?: string): Promise<MacIndex> {
  const url = file instanceof File ? URL.createObjectURL(file) : file.url;
  const type = file instanceof File ? file.type : "";
  try {
    // a picture: the window's own decode, else the Mac's (HEIC, RAW); none from either is listed with no picture, and its card says so
    if (type.startsWith("image/") || PICTURE_FILE.test(file.name)) return (await pictureIndex(file, url, path)) ?? { frames: [] };
    const audio = type.startsWith("audio/") || /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(file.name);
    const el = document.createElement(audio ? "audio" : "video") as HTMLVideoElement;
    el.muted = true;
    el.preload = "auto";
    el.src = url;
    try {
      await once(el, "loadedmetadata", signal);
      const duration = Number.isFinite(el.duration) ? el.duration : 0;
      if (audio || !el.videoWidth) return { ...(duration ? { duration } : {}), frames: [] };
      // a frame decoded before the first seek, else WebKit hands over a black first picture (seen in the Mac's WebKit)
      if (el.readyState < 2) await Promise.race([once(el, "loadeddata", signal), pause(3000)]);
      const shown = () =>
        new Promise<void>((done) => {
          const v = el as HTMLVideoElement & { requestVideoFrameCallback?: (f: () => void) => number };
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => done());
          setTimeout(done, 400); // a frame that never shows (an odd file) still moves on
        });
      const at = async (t: number) => {
        signal?.throwIfAborted();
        el.currentTime = Math.min(Math.max(0, t), Math.max(0, duration - 0.05));
        await once(el, "seeked", signal);
        await shown();
      };
      const sw = el.videoWidth;
      const sh = el.videoHeight;
      await at(duration * 0.1);
      const thumb = await toB64(draw(el, sw, sh, 480));
      // each frame in the clip's own shape, as the server makes them (api/library/media/sprite.ts)
      const k = SPRITE_SIDE / Math.max(sw, sh, 1);
      const [cw, ch] = [sw, sh].map((n) => Math.max(2, Math.round((n * k) / 2) * 2));
      const strip = document.createElement("canvas");
      strip.width = cw * SPRITE_FRAMES;
      strip.height = ch;
      for (let i = 0; i < SPRITE_FRAMES; i++) {
        await at(frameAt(i, SPRITE_FRAMES, duration));
        strip.getContext("2d")!.drawImage(draw(el, sw, sh, cw, ch), i * cw, 0);
      }
      const frames: string[] = [];
      for (let i = 0; i < STILLS; i++) {
        await at(frameAt(i, STILLS, duration));
        frames.push(await toB64(draw(el, sw, sh, 512), 0.7));
      }
      return { duration, width: sw, height: sh, thumb, sprite: await toB64(strip, 0.7), frames };
    } catch (e) {
      if (signal?.aborted) throw e;
      return { frames: [] }; // a format this window doesn't decode (MKV, some camera files): listed by name and size
    } finally {
      el.removeAttribute("src");
      el.load();
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    return { frames: [] };
  } finally {
    if (file instanceof File) URL.revokeObjectURL(url);
  }
}

/** The Mac app's own id on this server, when it is paired, so the server knows which Mac holds the file. */
export const deviceHere = async () => ((await thisMacBridge()?.postMessage("state").catch(() => null))?.device ?? undefined);

/**
 * Indexes `file` (at `path` on this Mac) into `libraryId`: { assetId } or { duplicateOf }. Nothing of the video is sent.
 * `blur`: the library has Blur faces on: the whole file's SHA-256 goes with it (the key its blurred render links on) and
 * no card picture or strip (the server keeps none of a clip not blurred).
 */
export async function indexOnMac(libraryId: string, file: File | MacFile, path: string, collectionId?: string, signal?: AbortSignal, blur = false): Promise<{ assetId?: string; duplicateOf?: string; duplicate?: true }> {
  const [quick, read, device, sha256] = await Promise.all([
    file instanceof File ? quickPrint(file) : file.quick,
    readIndex(file, signal, path),
    deviceHere(),
    blur ? importHash([path]).then((h) => h[path]) : undefined,
  ]);
  signal?.throwIfAborted();
  const index = blur ? { ...read, thumb: undefined, sprite: undefined } : read;
  const r = await fetch(`/api/library/${libraryId}/on-mac`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, path, size: file.size, quick, device, collectionId, ...index, ...(sha256 ? { sha256 } : {}) }),
    signal,
  });
  const body = (await r.json().catch(() => ({}))) as { assetId?: string; duplicateOf?: string; duplicate?: true; error?: string };
  if (!r.ok) throw new Error(body.error ?? "Could not add the file");
  return body;
}

/**
 * A file on this Mac into `libraryId` as the upload setting `upload` says: read in place with nothing sent ("none"), or
 * this Mac sends its proxy, and the file too for "all" (the server's send job). { assetId } or { duplicateOf }.
 */
export async function addFromMac(libraryId: string, file: MacFile, path: string, collectionId: string | undefined, upload: LibraryUpload): Promise<{ assetId?: string; duplicateOf?: string }> {
  const fromDevice = hostsOriginals(upload) || hostsProxies(upload) ? await deviceHere() : undefined;
  if (fromDevice) {
    const r = await fetch(`/api/library/${libraryId}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: file.name, size: file.size, collectionId, fromPath: path, fromDevice, quick: file.quick, send: true }),
    });
    const body = (await r.json().catch(() => ({}))) as { id?: string; sent?: true; assetId?: string; duplicateOf?: string; error?: string };
    if (!r.ok) throw new Error(body.error ?? "Could not add the file");
    if (body.sent || body.duplicateOf) return body;
    // ponytail: this Mac can't send it (an older Mac app): read in place, nothing sent; the byte upload needs the File
    if (body.id) void fetch(`/api/library/uploads/${body.id}`, { method: "DELETE" }).catch(() => {});
  }
  return indexOnMac(libraryId, file, path, collectionId);
}

/**
 * Where each file of a Finder drop is on this Mac. `items` are the drop's own paths (the Mac app's, droppedOnMac); a file
 * read from inside a dropped folder has its place in the drop ("FOOTAGE/a.mp4"), joined to that folder's parent. A
 * loose file is the one dropped item of its name. A name dropped twice is left out (no guess). `known`: paths known already.
 */
export function pathsInDrop(files: File[], items: { path: string; folder: boolean }[], known = new Map<File, string>()): Map<File, string> {
  const nfc = (s: string) => s.normalize("NFC");
  const out = new Map(known);
  for (const f of files) {
    if (out.has(f)) continue;
    const rel = nfc(f.webkitRelativePath || "");
    const top = rel.split("/")[0];
    if (!rel.includes("/")) {
      // a loose file: the one dropped item of its name
      const same = items.filter((x) => !x.folder && nfc(x.path.split("/").pop() ?? "") === nfc(f.name));
      if (same.length === 1) out.set(f, same[0]!.path);
      continue;
    }
    const same = items.filter((x) => x.folder && nfc(x.path.replace(/\/+$/, "").split("/").pop() ?? "") === top);
    if (same.length !== 1) continue;
    const parent = same[0]!.path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    out.set(f, `${parent}/${rel}`);
  }
  return out;
}

/**
 * This library's photos with no thumbnail whose file this Mac has get one now, made here (pictureIndex through the Mac's
 * own decode), with no re-import (11-19: photos indexed before the Mac could make HEIC pictures came in grey). Run by
 * Look for new files and once when the Library opens in the Mac app. Resolves to how many got a picture.
 */
export async function repairPictures(libraryId: string, signal?: AbortSignal): Promise<number> {
  const device = await deviceHere();
  if (!device) return 0;
  const r = await fetch(`/api/library/${libraryId}/no-picture?device=${encodeURIComponent(device)}`).catch(() => null);
  if (!r?.ok) return 0;
  const { versions } = (await r.json()) as { versions: { versionId: string; path: string }[] };
  let filled = 0;
  for (const v of versions) {
    signal?.throwIfAborted();
    const made = await importThumb(v.path);
    if (!made) continue;
    const put = await fetch(`/api/library/${libraryId}/versions/${v.versionId}/thumb`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ thumb: made.thumb }) }).catch(() => null);
    if (put?.ok) filled++;
  }
  return filled;
}

/**
 * Videos whose old 16:9 strip isn't their shape (an upright clip's), made again here from the file on this Mac with the
 * same read as an index (readIndex) and handed in: the card shows the old strip until the new one lands. Returns how many.
 */
export async function repairStrips(libraryId: string, signal?: AbortSignal): Promise<number> {
  const device = await deviceHere();
  if (!device) return 0;
  const r = await fetch(`/api/library/${libraryId}/stray-strips?device=${encodeURIComponent(device)}`).catch(() => null);
  if (!r?.ok) return 0;
  const { versions } = (await r.json()) as { versions: { versionId: string; path: string }[] };
  let made = 0;
  for (const v of versions) {
    signal?.throwIfAborted();
    const { sprite } = await readIndex({ url: macMediaUrl(v.path), name: v.path.split("/").pop() ?? "", size: 0, quick: "" }, signal, v.path);
    if (!sprite) continue;
    const put = await fetch(`/api/library/${libraryId}/versions/${v.versionId}/sprite`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sprite }) }).catch(() => null);
    if (put?.ok) made++;
  }
  return made;
}
