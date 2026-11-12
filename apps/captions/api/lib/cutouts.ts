import { CUTOUT_KIND, type DeviceJob } from "../../contracts/devices";
import { needsLine } from "../../contracts/tools";
import { isOnline, listDevices } from "./devices";
import { wakeEditorPolls } from "./mac-claude";

/**
 * Cut-outs: a still picture cut out of its background by a Mac of the person's own (the Mac app's Cutout.swift, the
 * foreground mask macOS has built in). The server never decodes a picture: it checks the size and the first bytes, hands
 * the bytes to the Mac that claims the cut-out (api/devices.ts, the claim road of the editor's device steps), and takes
 * back only a PNG under the cap. Kept in memory: a cut-out lives as long as the call that waits for it.
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

interface Cut {
  id: number;
  owner: string;
  picture: Buffer;
  mime: string;
  /** the device that claimed it */
  device?: string;
  end: (r: Buffer | Error) => void;
}
const cuts = new Map<number, Cut>();
let lastId = 0;

/** Why this account can't have a picture cut out now, in the app's words for what is missing; null when a Mac of its own can. */
export function cutoutMissing(owner: string): string | null {
  const on = listDevices((d) => d.owner === owner && isOnline(d.id));
  if (on.some((d) => d.kinds?.includes(CUTOUT_KIND))) return null;
  // a Mac that is on but lists no cut-out has an app older than the cut-out
  return needsLine([{ what: on.length ? "The newest Creator Toolset Mac app" : "A Mac with Creator Toolset on", anyOf: [], form: "ai" }]);
}

/**
 * `picture` cut out of its background as PNG bytes, by a Mac of `owner`'s own. Rejects with a sentence a person can
 * read: what is missing, a picture that is not one, a cap, the Mac's own words, or the time running out.
 */
export function cutOut(owner: string, picture: Buffer): Promise<Buffer> {
  const mime = pictureType(picture);
  const refused =
    picture.length > CUTOUT_LIMITS.bytes ? `The picture is over ${CUTOUT_LIMITS.bytes / 1e6} MB.`
    : !mime ? "That is not a PNG, JPEG or HEIC picture."
    : cutoutMissing(owner) ??
      ([...cuts.values()].filter((c) => c.owner === owner).length >= CUTOUT_LIMITS.waiting ? `${CUTOUT_LIMITS.waiting} pictures are being cut out already: wait for one of them.` : null);
  if (refused) return Promise.reject(new Error(refused));
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    const timer = setTimeout(() => end(new Error(`Your Mac did not cut the picture out in ${CUTOUT_LIMITS.ms / 1000} seconds.`)), CUTOUT_LIMITS.ms);
    const end = (r: Buffer | Error) => {
      clearTimeout(timer);
      cuts.delete(id);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    cuts.set(id, { id, owner, picture, mime: mime!, end });
    // a poll the Mac holds right now is told at once, not up to 25 s later
    void wakeEditorPolls();
  });
}

/** Whether a cut-out of this account waits for a Mac to claim it. */
export const cutoutWaits = (owner: string): boolean => [...cuts.values()].some((c) => c.owner === owner && !c.device);

/** A device's claim with these kinds: the oldest waiting cut-out of its own account, now this device's. */
export function claimCutout(device: { id: string; owner: string }, kinds: string[]): DeviceJob | null {
  const c = kinds.includes(CUTOUT_KIND) ? [...cuts.values()].find((x) => x.owner === device.owner && !x.device) : undefined;
  if (!c) return null;
  c.device = device.id;
  return { id: c.id, kind: CUTOUT_KIND, editId: "", variant: "" };
}

/** The cut-out this device claimed and is still making, or null. */
export const heldCutout = (device: string, id: number): { picture: Buffer; mime: string } | null => {
  const c = cuts.get(id);
  return c?.device === device ? c : null;
};

/** What the Mac sent: a PNG under the cap ends the cut-out with it, anything else fails it. The reason, "Not found" (not this device's), or null. */
export function cutoutSent(device: string, id: number, png: Buffer | null): string | null {
  const c = cuts.get(id);
  if (c?.device !== device) return "Not found";
  const wrong = !png?.subarray(0, 8).equals(PNG) ? "Your Mac sent no PNG." : png.length > CUTOUT_LIMITS.result ? `The cut-out is over ${CUTOUT_LIMITS.result / 1e6} MB.` : null;
  c.end(wrong ? new Error(wrong) : png!);
  return wrong;
}

/** The Mac could not make it: the cut-out fails with its words. False when it is not this device's. */
export function cutoutFailed(device: string, id: number, why: string): boolean {
  const c = cuts.get(id);
  if (c?.device !== device) return false;
  c.end(new Error(why.slice(0, 500)));
  return true;
}
