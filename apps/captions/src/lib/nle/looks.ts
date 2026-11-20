// What the editor's player puts on a picture's colour (components/nle/NlePlayer.tsx, drawn by gl-stage.ts): its source's
// camera conversion (a log curve or an added LUT, EDJ `camera`, per source) and then its clip's grade (EDJ `grade`, his
// CDL), the engine's order (grade.py look: Resolve's nodes 1 and 2). The curve's table is the engine's own: the same
// cube() text the site serves the worker, read back, so both look up the same 33 points.

import { convert, cube, PROFILES, readCube, type Profile } from "@contracts/camera";
import type { EdjCamera } from "@contracts/editor";
import { cdl, isNeutral, type Grade } from "@contracts/grade";

/** A 3D LUT: `size` points per side, RGB triples with red changing fastest (the .cube order). */
export type LutTable = { id: string; size: number; values: Float32Array };
/** A grade as the shader takes it: the CDL's slope, offset, power and saturation. */
export type GradeCdl = ReturnType<typeof cdl>;

const tables = new Map<string, LutTable | null | Promise<void>>();

/** The table a camera conversion takes; null when it has none or its file isn't here yet (`loaded` is called once it is). */
export function lutOf(cam: EdjCamera | undefined, loaded: () => void, get: typeof fetch = fetch): LutTable | null {
  const id = cam?.on ? cam.lut ?? cam.curve : undefined;
  if (!id) return null;
  const have = tables.get(id);
  if (have !== undefined) return have instanceof Promise ? null : have;
  if (!cam!.lut) {
    const t = id in PROFILES ? readCube(cube(convert(id as Profile))) : { error: "not a curve" };
    tables.set(id, "error" in t ? null : { id, size: t.size, values: t.values });
    return tables.get(id) as LutTable | null;
  }
  // an added LUT, as the worker gets it (api/editor/luts.ts); one with a 1D shaper is refused by readCube
  // shortcut: a LUT that failed to load stays off until the page loads again; retry on a timer if that bites
  tables.set(id, get(`/api/edit-steps/luts/${encodeURIComponent(id)}`)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then((text) => {
      const t = readCube(text);
      if ("error" in t) console.warn(`LUT ${id}: ${t.error}`);
      tables.set(id, "error" in t ? null : { id, size: t.size, values: t.values });
    }, () => void tables.set(id, null))
    .finally(loaded));
  return null;
}

/** The clip's grade as a CDL; null for none or a neutral one. */
export const gradeOf = (g: unknown): GradeCdl | null => (g && typeof g === "object" && !isNeutral(g as Partial<Grade>) ? cdl(g as Partial<Grade>) : null);

/**
 * Whether a picture takes a colour change: its camera conversion is on and the file it plays is log (`log`, from the
 * Media Library for a proxy or master; not said = log, as an original is), or its clip has a grade. Then it is never
 * shown as the plain <video>.
 */
export const hasLook = (cam: EdjCamera | undefined, log: boolean | undefined, grade: unknown) =>
  (!!cam?.on && !!(cam.lut ?? cam.curve) && log !== false) || !!gradeOf(grade);
