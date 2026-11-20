import { DESIGN_GAP, DESIGN_LIMITS, type Design, type DesignListed, type DesignPage, type NewDesign, type SplitAnswer } from "@contracts/design";

/** The designer's calls to api/designs.ts. */

/** A save the server did not take, because the design was changed somewhere else since this window last read it: `design` is how it is now. */
export class DesignChanged extends Error {
  design: Design;
  constructor(design: Design) {
    super("The design was changed somewhere else");
    this.design = design;
  }
}

/** An answer that is not ok: its words, and its `code` and the `device` it names when it has them (a Mac that is not reachable). */
export type SendError = Error & { code?: string; device?: { id: string; name: string }; status?: number };

/** `keepalive`: carried on by the browser after the page is gone (the window closing), when it is small enough (64 KB). */
async function send<T>(url: string, method = "GET", body?: unknown, signal?: AbortSignal, keepalive = false): Promise<T> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const init = { method, signal, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: text };
  // the browser's limit is in bytes, shared with its other such requests: refused, it is sent the plain way
  const small = keepalive && new Blob([text ?? ""]).size < 60_000;
  const r = await (small ? fetch(url, { ...init, keepalive: true }).catch(() => fetch(url, init)) : fetch(url, init));
  const out = (await r.json().catch(() => ({}))) as T & { error?: string; design?: Design; code?: string; device?: { id: string; name: string } };
  if (r.status === 409 && out.design) throw new DesignChanged(out.design);
  if (!r.ok) throw Object.assign(new Error(out.error ?? `Request failed (${r.status})`), { code: out.code, device: out.device, status: r.status }) as SendError;
  return out;
}

const base = (id: string) => `/api/designs/${id}`;

/** My designs, newest first; `piece` narrows them to one Workshop carousel piece's. */
export const listDesigns = (piece?: { session: string; doc: string }) => send<DesignListed[]>(`/api/designs${piece ? `?session=${encodeURIComponent(piece.session)}&doc=${encodeURIComponent(piece.doc)}` : ""}`);
export const createDesign = (d: NewDesign) => send<Design>("/api/designs", "POST", d);
export const getDesign = (id: string) => send<Design>(base(id));
/** `since`: the design's last change this window knows of (its updatedAt). Changed after it: DesignChanged, and nothing was saved. */
/** `notes`: what the server's check left out of what was sent (past a limit), each said. */
/** `by` and `n`: this window and its count of saves, so a later save of its own on top of its own (one sent as it closed) is never refused, and an earlier one never written over a later (contracts Design `writer`). */
export const saveDesign = (id: string, body: { name?: string; pages?: DesignPage[]; since?: number; by?: string; n?: number }, keepalive = false) =>
  send<Design & { notes?: string[]; changes?: string[] }>(base(id), "PUT", body, undefined, keepalive);
export const deleteDesign = (id: string) => send<{ ok: true }>(base(id), "DELETE");
export const pictureUrl = (id: string, picture: string) => `${base(id)}/pictures/${picture}`;

/** One of the design's pictures with its background taken away, as a new picture of the design: its id. Cut by a Mac of the person's own; the error says what is missing when none is on. */
export const cutOutPicture = async (id: string, picture: string, signal?: AbortSignal) => (await send<{ id: string }>(`${base(id)}/pictures/${picture}/cutout`, "POST", {}, signal)).id;
/** The picture split by a Mac of the person's own: what is behind its words and pieces, each piece, and its lines (lib/design/split.ts makes them layers). */
export const splitPicture = (id: string, picture: string, signal?: AbortSignal) => send<SplitAnswer>(`${base(id)}/pictures/${picture}/split`, "POST", {}, signal);

/**
 * A picture from this computer into the design's own folder, as it is (no shrinking, transparency kept); answers its
 * id. `as`: the id it gets (pictureId), so a window shows it before it is there. `stamp` hears the design's updatedAt
 * after it and before it.
 */
export async function addPicture(id: string, file: File, as?: string, stamp?: (updatedAt: number, was: number) => void): Promise<string> {
  const data = await new Promise<string>((done, fail) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
  const r = await send<{ id: string; updatedAt: number; was: number }>(`${base(id)}/pictures`, "POST", { name: file.name, type: file.type, data, ...(as ? { id: as } : {}) });
  stamp?.(r.updatedAt, r.was);
  return r.id;
}

/** A new picture id for a file of a type isPicture takes, as the server makes them. */
export const pictureId = (file: File): string => `${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}.${file.type === "image/jpeg" ? "jpg" : file.type.slice(6)}`;

/** The picture types a design takes. */
export const isPicture = (f: File): boolean => /^image\/(jpeg|png|webp)$/.test(f.type);

/** A picture file's own size in pixels; 1 × 1 when the browser cannot read it. */
export function pictureSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((done) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const end = (w: number, h: number) => (URL.revokeObjectURL(url), done({ w: w || 1, h: h || 1 }));
    img.onload = () => end(img.naturalWidth, img.naturalHeight);
    img.onerror = () => end(1, 1);
    img.src = url;
  });
}

/**
 * Frames made of pictures: each the picture's own size (fitted to what a frame may be), the picture filling it, laid in
 * a row with the first one's middle at (x, y). What a picture dropped on empty canvas, or on the start screen, becomes.
 */
export function pictureFrames(pictures: readonly { picture: string; w: number; h: number }[], x: number, y: number, ids: readonly string[]): DesignPage[] {
  let left: number | null = null;
  return pictures.map((p, n) => {
    const k = Math.min(1, DESIGN_LIMITS.frameMax / Math.max(p.w, p.h));
    const w = Math.max(DESIGN_LIMITS.frameMin, Math.round(p.w * k));
    const h = Math.max(DESIGN_LIMITS.frameMin, Math.round(p.h * k));
    const fx: number = left ?? Math.round(x - w / 2);
    left = fx + w + DESIGN_GAP;
    return { id: ids[n]!, x: fx, y: Math.round(y - h / 2), w, h, background: "#ffffff", layers: [{ id: "l1", type: "image", picture: p.picture, fit: "cover", x: 0, y: 0, w, h }] };
  });
}

