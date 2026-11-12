import { cdl, type Grade } from "@contracts/grade";

/**
 * Grading in Review's Color panel: a still at full quality (12-bit RGB at data
 * levels over 0..TOP, superwhites kept), graded here exactly, and a gallery of
 * graded stills kept in this browser (IndexedDB). The stills and clips come
 * from a plug-in (ReviewTimelineSlot.look in lib/plugin.ts); a full-quality
 * clip is H.264 squeezed by 1/TOP.
 */

export const TOP = 1.1;
/** the clip's squeeze, as a grade: the live filter undoes it */
export const SQUEEZE: Partial<Grade> = { gain: [1 / TOP, 1 / TOP, 1 / TOP] };

export interface Still { w: number; h: number; codes: Uint16Array }
export interface Sample { w: number; h: number; px: Float32Array }

// ---- grading a still, exactly (the CDL per 12-bit code, then saturation) -------

function tables(g?: Partial<Grade> | null) {
  const { slope, offset, power, sat } = cdl(g);
  const lut = [0, 1, 2].map((c) => {
    const t = new Float32Array(4096);
    for (let k = 0; k < 4096; k++) t[k] = Math.max((k / 4095) * TOP * slope[c] + offset[c], 0) ** power[c];
    return t;
  });
  return { lut, sat };
}

/** `a` graded with `ga`; right of `b.x` (0-1), `b.still` graded with `b.g` (a wipe). */
export function paint(img: ImageData, a: Still, ga: Partial<Grade> | null, b?: { still: Still; g: Partial<Grade> | null; x: number }) {
  const { w, h } = a;
  const ta = tables(ga);
  const tb = b && tables(b.g);
  const cut = b ? Math.round(b.x * w) : w;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const other = x >= cut && b && tb;
      const s = other ? b.still : a;
      const t = other ? tb : ta;
      const i = other && (s.w !== w || s.h !== h)
        ? (Math.floor((y * s.h) / h) * s.w + Math.floor((x * s.w) / w)) * 3
        : (y * w + x) * 3;
      const r = t.lut[0][s.codes[i]], g = t.lut[1][s.codes[i + 1]], bl = t.lut[2][s.codes[i + 2]];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      const o = (y * w + x) * 4;
      d[o] = (l + t.sat * (r - l)) * 255;
      d[o + 1] = (l + t.sat * (g - l)) * 255;
      d[o + 2] = (l + t.sat * (bl - l)) * 255;
      d[o + 3] = 255;
    }
  }
}

/** Every `step`th pixel of a still at data levels, for the scopes. */
export function sampleStill(s: Still, step = 8): Sample {
  const w = Math.floor(s.w / step), h = Math.floor(s.h / step);
  const px = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * step * s.w + x * step) * 3;
      for (let c = 0; c < 3; c++) px[(y * w + x) * 3 + c] = (s.codes[i + c] / 4095) * TOP;
    }
  }
  return { w, h, px };
}

const reader = typeof document === "undefined" ? null : document.createElement("canvas");
/** A playing <video>'s frame, small, as data levels (`scale` = what 1.0 on screen means). Throws when it can't be read. */
export function sampleVideo(el: HTMLVideoElement | null, scale = 1, W = 120): Sample | null {
  const ctx = reader?.getContext("2d", { willReadFrequently: true });
  if (!el || !ctx || !el.videoWidth) return null;
  const H = Math.round((W * el.videoHeight) / el.videoWidth);
  reader!.width = W;
  reader!.height = H;
  ctx.drawImage(el, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const px = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) px[p * 3 + c] = (d[p * 4 + c] / 255) * scale;
  return { w: W, h: H, px };
}

// ---- the gallery: stills kept in this browser, per project ---------

export interface GalleryStill {
  id: string;
  project: string;
  label: string;
  still: Still;
  grade: Grade;
  thumb: string;
  created: number;
}

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open("ct-grade-gallery", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("stills", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = fn(d.transaction("stills", mode).objectStore("stills"));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export const gallery = {
  all: async (project: string) =>
    ((await store("readonly", (s) => s.getAll())) as GalleryStill[]).filter((x) => x.project === project).sort((a, b) => a.created - b.created),
  put: (s: GalleryStill) => store("readwrite", (st) => st.put(s)),
  remove: (id: string) => store("readwrite", (st) => st.delete(id)),
};
