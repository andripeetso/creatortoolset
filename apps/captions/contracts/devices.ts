/**
 * Editor steps that run on a device (a Mac on the account, paired in Settings → Devices). A device declares the step
 * kinds it can run when it claims work; the server hands it only device kinds (api/editor/engine.ts) and only jobs of
 * its own account's edits. Routes (api/devices.ts, under /api/devices/relay/, Authorization: Bearer ctd_…):
 *   POST editor/claim          DeviceClaimBody → DeviceClaim      declare kinds, take one step (or job: null)
 *   POST editor/job/:id/beat                    → { ok: boolean } keep a step's lease while it runs (every 15 s or so)
 *   POST editor/job/:id/done                    → DeviceEnded     the step finished
 *   POST editor/job/:id/fail   { error }        → DeviceEnded     the step failed (retried later, or failed after 3 tries)
 * A device never asks for a step on a clock. Its long poll for AI requests (POST wait) lists the kinds it would claim
 * right now, `{ blobs, editor: string[] }`: they are kept as the kinds it declares (an empty list: none), and when a
 * claim made now would be handed a step the poll is answered at once with EDITOR_HINT, after any AI request. The device
 * then claims. A poll that lists no `editor` changes nothing and is never answered with the hint.
 *   GET  editor/job/:id/cards                   → CardsDraw       a cards-draw step: what to draw
 *   POST editor/job/:id/cards/:cardId           multipart: `clip` (H.264 mp4, no sound) and `still` three times (PNG, 540 px
 *                                               wide: first, middle and last frame) → { ok: true }; then done or fail
 * ok is false when the device does not hold that step (not claimed by it, or already released). A device that is not
 * online (no call in the last 40 s) loses the steps it holds; they go back in the queue.
 */

/**
 * The step kind of the Resolve bridge (the Mac app's ResolveBridge). A device is handed it only while its account has an
 * installed pack with Resolve items (api/lib/packs.ts resolveGranted); without one the helper stays off.
 */
export const RESOLVE_KIND = "resolve";

/**
 * The step kind that draws an edit's cards (the Mac app's sandboxed page). The script in a CardsDraw is an AI's output:
 * it runs only there, never on the server and never in a page of this app.
 */
export const CARDS_DRAW_KIND = "cards-draw";

/**
 * The kind that cuts a still picture out of its background on a Mac (api/lib/cutouts.ts; the Mac app's Cutout.swift). Not an
 * edit step: a person's call queues it (the cut-out plug-in), and a Mac lists, is hinted and claims it on the road above.
 *   GET  cutout/:id                             → the picture (PNG, JPEG or HEIC)
 *   POST cutout/:id        multipart `cutout`: the PNG, its background see-through → DeviceEnded
 *   POST cutout/:id/fail   { error }            → DeviceEnded
 */
export const CUTOUT_KIND = "cutout";

/** What a cards-draw step asks a Mac to draw: one script for every card of a version, and each card's length and content. */
export interface CardsDraw {
  /** the picture's size in pixels (even numbers) and its frames a second */
  width: number;
  height: number;
  fps: number;
  /** defines kitFrame(t, card) and paints into #stage */
  script: string;
  cards: { id: string; seconds: number; content: { id: string; text: string; line: string } }[];
}

/** The whole answer to a long poll that says an editor step waits. It has no `id`: an answer with one is an AI request. */
export const EDITOR_HINT = { editor: true } as const;

/** The answer to done and fail. `editor: true`: another step this device could claim waits, so it may claim at once. */
export interface DeviceEnded {
  ok: boolean;
  editor?: true;
}

/** Most kinds one device may declare. */
export const DEVICE_KINDS_MAX = 20;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;

/** The kinds a device declares: a list of lowercase words, no repeats. Null when the value is not such a list. */
export function parseKinds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > DEVICE_KINDS_MAX) return null;
  if (!value.every((k) => typeof k === "string" && KIND.test(k))) return null;
  return [...new Set(value as string[])];
}

export interface DeviceClaimBody {
  kinds: string[];
}

/** A step handed to a device: its job id, its kind, and the edit it belongs to ("" variant = the whole edit). */
export interface DeviceJob {
  id: number;
  kind: string;
  editId: string;
  variant: string;
}

export interface DeviceClaim {
  job: DeviceJob | null;
}
