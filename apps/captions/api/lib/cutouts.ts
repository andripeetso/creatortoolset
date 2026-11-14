import type { SplitBox, SplitLayout, SplitLine } from "../../contracts/design";
import { CUTOUT_KIND, SPLIT_KIND, type DeviceJob } from "../../contracts/devices";
import { needsLine } from "../../contracts/tools";
import { isOnline, listDevices } from "./devices";
import { wakeEditorPolls } from "./mac-claude";

/**
 * Cut-outs: a still picture cut out of its background by a Mac of the person's own (the Mac app's Cutout.swift, the
 * foreground mask macOS has built in). The server never decodes a picture: it checks the size and the first bytes, hands
 * the bytes to the Mac that claims the cut-out (api/devices.ts, the claim road of the editor's device steps), and takes
 * back only a PNG under the cap. Kept in memory: a cut-out lives as long as the call that waits for it.
 * A split (SPLIT_KIND) takes the same road: the Mac reads the picture's words and cuts out its pieces, and sends what is
 * left behind them, each piece, and where all of it lies.
 */

/** The input's bytes, the PNG's bytes, cut-outs waiting per account, and how long one may take. The pixels are the Mac's to check: it decodes (Cutout.maxPixels). */
export const CUTOUT_LIMITS = { bytes: 25_000_000, result: 40_000_000, waiting: 5, ms: 45_000 } as const;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG, JPEG or HEIC picture by its first bytes; null for anything else. */
export function pictureType(b: Buffer): "image/png" | "image/jpeg" | "image/heic" | null {
  if (b.subarray(0, 8).equals(PNG)) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // an ISO media file ("ftyp" at byte 4) whose brand is a HEIF picture's
  if (b.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|heim|heis|mif1)$/.test(b.toString("latin1", 8, 12))) return "image/heic";
  return null;
}

/** What a Mac made of a picture it split: what is left behind its words and pieces, each piece, and where they lie. */
export interface Split {
  layout: SplitLayout;
  background: Buffer;
  pieces: Buffer[];
}
/** The most lines and pieces a split may send: more than a frame holds as layers. */
const SPLIT_MOST = { lines: 60, pieces: 12, text: 500 } as const;

type Kind = typeof CUTOUT_KIND | typeof SPLIT_KIND;
interface Cut {
  id: number;
  owner: string;
  kind: Kind;
  picture: Buffer;
  mime: string;
  /** the device that claimed it */
  device?: string;
  end: (r: Buffer | Split | Error) => void;
}
const cuts = new Map<number, Cut>();
let lastId = 0;

/** Why this account can't have a picture cut out (or split) now, in the app's words for what is missing; null when a Mac of its own can. */
export function cutoutMissing(owner: string, kind: Kind = CUTOUT_KIND): string | null {
  const on = listDevices((d) => d.owner === owner && isOnline(d.id));
  if (on.some((d) => d.kinds?.includes(kind))) return null;
  // a Mac that is on but lists no cut-out (or split) has an app older than it
  return needsLine([{ what: on.length ? "The newest Creator Toolset Mac app" : "A Mac with Creator Toolset on", anyOf: [], form: "ai" }]);
}

/**
 * `picture` cut out of its background as PNG bytes, by a Mac of `owner`'s own. Rejects with a sentence a person can
 * read: what is missing, a picture that is not one, a cap, the Mac's own words, or the time running out.
 */
export const cutOut = (owner: string, picture: Buffer): Promise<Buffer> => ask<Buffer>(owner, picture, CUTOUT_KIND);

/** `picture` split by a Mac of `owner`'s own into its words, its pieces and what is behind them. Rejects as cutOut does. */
export const splitPicture = (owner: string, picture: Buffer): Promise<Split> => ask<Split>(owner, picture, SPLIT_KIND);

function ask<T extends Buffer | Split>(owner: string, picture: Buffer, kind: Kind): Promise<T> {
  const mime = pictureType(picture);
  const refused =
    picture.length > CUTOUT_LIMITS.bytes ? `The picture is over ${CUTOUT_LIMITS.bytes / 1e6} MB.`
    : !mime ? "That is not a PNG, JPEG or HEIC picture."
    : cutoutMissing(owner, kind) ??
      ([...cuts.values()].filter((c) => c.owner === owner).length >= CUTOUT_LIMITS.waiting ? `${CUTOUT_LIMITS.waiting} pictures are being ${kind === SPLIT_KIND ? "split" : "cut out"} already: wait for one of them.` : null);
  if (refused) return Promise.reject(new Error(refused));
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    const timer = setTimeout(() => end(new Error(`Your Mac did not ${kind === SPLIT_KIND ? "split the picture" : "cut the picture out"} in ${CUTOUT_LIMITS.ms / 1000} seconds.`)), CUTOUT_LIMITS.ms);
    const end = (r: Buffer | Split | Error) => {
      clearTimeout(timer);
      cuts.delete(id);
      if (r instanceof Error) reject(r);
      else resolve(r as T);
    };
    cuts.set(id, { id, owner, kind, picture, mime: mime!, end });
    // a poll the Mac holds right now is told at once, not up to 25 s later
    void wakeEditorPolls();
  });
}

/** Whether a cut-out or split of this account, of one of these kinds, waits for a Mac to claim it. */
export const cutoutWaits = (owner: string, kinds: string[]): boolean => [...cuts.values()].some((c) => c.owner === owner && !c.device && kinds.includes(c.kind));

/** A device's claim with these kinds: the oldest waiting cut-out or split of its own account it takes, now this device's. */
export function claimCutout(device: { id: string; owner: string }, kinds: string[]): DeviceJob | null {
  const c = [...cuts.values()].find((x) => x.owner === device.owner && !x.device && kinds.includes(x.kind));
  if (!c) return null;
  c.device = device.id;
  return { id: c.id, kind: c.kind, editId: "", variant: "" };
}

/** The cut-out this device claimed and is still making, or null. */
export const heldCutout = (device: string, id: number): { picture: Buffer; mime: string } | null => {
  const c = cuts.get(id);
  return c?.device === device ? c : null;
};

/**
 * What the Mac sent, its form's fields as bytes or text: a cut-out's PNG, or a split's layout with its PNGs, under the
 * cap, end it with that; anything else fails it. The reason, "Not found" (not this device's), or null.
 */
export function cutoutSent(device: string, id: number, form: Record<string, Buffer | string | undefined>): string | null {
  const c = cuts.get(id);
  if (c?.device !== device) return "Not found";
  const png = (b: unknown): b is Buffer => Buffer.isBuffer(b) && b.subarray(0, 8).equals(PNG);
  let wrong: string | null;
  let made: Buffer | Split | null = null;
  if (c.kind === CUTOUT_KIND) {
    wrong = !png(form.cutout) ? "Your Mac sent no PNG." : form.cutout.length > CUTOUT_LIMITS.result ? `The cut-out is over ${CUTOUT_LIMITS.result / 1e6} MB.` : null;
    if (!wrong) made = form.cutout as Buffer;
  } else {
    const layout = readLayout(form.layout);
    const pieces = layout ? layout.pieces.map((_, n) => form[`piece${n}`]) : [];
    const bytes = [form.background, ...pieces].reduce((sum, b) => sum + (Buffer.isBuffer(b) ? b.length : 0), 0);
    wrong =
      !layout ? "Your Mac sent no layout this app can read."
      : !png(form.background) || !pieces.every(png) ? "Your Mac sent no PNG."
      : bytes > CUTOUT_LIMITS.result ? `The split is over ${CUTOUT_LIMITS.result / 1e6} MB.`
      : null;
    if (!wrong) made = { layout: layout!, background: form.background as Buffer, pieces: pieces as Buffer[] };
  }
  c.end(made ?? new Error(wrong!));
  return wrong;
}

const fraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const boxOf = (b: unknown): SplitBox | null => {
  const r = b as Record<string, unknown> | null;
  return r && [r.x, r.y, r.w, r.h].every(fraction) ? { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number } : null;
};
/**
 * A split's layout as a Mac sent it (JSON), or null when it is not one. A line whose box is not a fraction of the
 * picture or whose colour is not #rrggbb is left out, and lines past the cap: the rest of the split stands. A piece
 * that is not one fails it all, since the pieces are the form's piece0, piece1… in their order.
 */
export function readLayout(sent: unknown): SplitLayout | null {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.isBuffer(sent) ? sent.toString("utf8") : String(sent ?? ""));
  } catch {
    return null;
  }
  const r = v as { lines?: unknown; pieces?: unknown } | null;
  if (!r || !Array.isArray(r.lines) || !Array.isArray(r.pieces) || r.pieces.length > SPLIT_MOST.pieces) return null;
  const lines: SplitLine[] = [];
  for (const l of r.lines as (Record<string, unknown> | null)[]) {
    const box = l && boxOf(l);
    if (!l || !box || typeof l.text !== "string" || !l.text.trim() || typeof l.color !== "string" || !/^#[0-9a-f]{6}$/i.test(l.color) || !fraction(l.ink)) continue;
    if (lines.push({ ...box, text: l.text.trim().slice(0, SPLIT_MOST.text), color: l.color.toLowerCase(), ink: l.ink }) >= SPLIT_MOST.lines) break;
  }
  const pieces = (r.pieces as unknown[]).map(boxOf);
  return pieces.every(Boolean) ? { lines, pieces: pieces as SplitBox[] } : null;
}

/** The Mac could not make it: the cut-out or split fails with its words. False when it is not this device's. */
export function cutoutFailed(device: string, id: number, why: string): boolean {
  const c = cuts.get(id);
  if (c?.device !== device) return false;
  c.end(new Error(why.slice(0, 500)));
  return true;
}
