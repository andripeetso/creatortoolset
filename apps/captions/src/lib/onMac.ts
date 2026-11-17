import { SPRITE_FRAMES } from "@contracts/library";
import { thisMacBridge } from "@/lib/thisMac";

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

/** What the server lists `file` by, read here. A file the app can't decode is indexed by its name and size only. */
export async function readIndex(file: File | MacFile, signal?: AbortSignal): Promise<MacIndex> {
  const url = file instanceof File ? URL.createObjectURL(file) : file.url;
  const type = file instanceof File ? file.type : "";
  try {
    if (type.startsWith("image/") || /\.(jpe?g|png|heic|webp|gif|tiff?)$/i.test(file.name)) {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight, thumb: await toB64(draw(img, img.naturalWidth, img.naturalHeight, 480)), frames: [] };
    }
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
      const strip = document.createElement("canvas");
      strip.width = 160 * SPRITE_FRAMES;
      strip.height = 90;
      for (let i = 0; i < SPRITE_FRAMES; i++) {
        await at(frameAt(i, SPRITE_FRAMES, duration));
        strip.getContext("2d")!.drawImage(draw(el, sw, sh, 160, 90), i * 160, 0);
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

/** Indexes `file` (at `path` on this Mac) into `libraryId`: { assetId } or { duplicateOf }. Nothing of the video is sent. */
export async function indexOnMac(libraryId: string, file: File | MacFile, path: string, collectionId?: string, signal?: AbortSignal): Promise<{ assetId?: string; duplicateOf?: string; duplicate?: true }> {
  const [quick, index, device] = await Promise.all([file instanceof File ? quickPrint(file) : file.quick, readIndex(file, signal), deviceHere()]);
  signal?.throwIfAborted();
  const r = await fetch(`/api/library/${libraryId}/on-mac`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, path, size: file.size, quick, device, collectionId, ...index }),
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
export async function addFromMac(libraryId: string, file: MacFile, path: string, collectionId: string | undefined, upload: "none" | "proxies" | "all"): Promise<{ assetId?: string; duplicateOf?: string }> {
  const fromDevice = upload === "none" ? undefined : await deviceHere();
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
