/**
 * Editor steps that run on a device (a Mac on the account, paired in Settings → Devices). A device declares the step
 * kinds it can run when it claims work; the server hands it only device kinds (api/editor/engine.ts) and only jobs of
 * its own account's edits. Routes (api/devices.ts, under /api/devices/relay/, Authorization: Bearer ctd_…):
 *   POST editor/claim          DeviceClaimBody → DeviceClaim      declare kinds, take one step (or job: null)
 *   POST editor/job/:id/beat                    → { ok: boolean } keep a step's lease while it runs (every 15 s or so)
 *   POST editor/job/:id/done                    → { ok: boolean } the step finished
 *   POST editor/job/:id/fail   { error }        → { ok: boolean } the step failed (retried later, or failed after 3 tries)
 * ok is false when the device does not hold that step (not claimed by it, or already released). A device that is not
 * online (no call in the last 40 s) loses the steps it holds; they go back in the queue.
 */

/**
 * The step kind of the Resolve bridge (the Mac app's ResolveBridge). A device is handed it only while its account has an
 * installed pack with Resolve items (api/lib/packs.ts resolveGranted); without one the helper stays off.
 */
export const RESOLVE_KIND = "resolve";

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
