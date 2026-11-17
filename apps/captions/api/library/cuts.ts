import { existsSync } from "node:fs";
import type { InferenceSession } from "onnxruntime-node";
import { modelBytes } from "../editor/eyeline";

/**
 * Cuts found by a shot boundary model (TransNetV2, MIT) on a computer whose graphics card runs it, read in the same
 * decode as look.ts readPicture. Measured on 2026-11-16 (docs: TransNetV2 on a graphics card): on labelled clips it finds
 * 90% of real hard cuts where cutsOf finds 53%, and on game footage none of cutsOf's false cuts (muzzle flashes, fast
 * turns, menus). On an RTX 4080 Super it costs 0.2 min per hour of footage and 0.6 GB of the card; on a processor 8-60
 * min, so everywhere else cutsOf stays. On a Mac it is never used: onnxruntime's CoreML provider runs under half the net
 * and stops the process on the Mac's GPU (a native CoreML build would run it at 0.6 min an hour; not shipped).
 * Which way a file's cuts were found is kept with its stretches (asset_versions.cuts_by); a file is read again only
 * when someone asks for its shots again.
 */

/** The ONNX export of TransNetV2 on Hugging Face (MIT), 31 MB, fetched once into the models folder. */
export const TRANSNET = {
  url: "/elya5/transnetv2/resolve/e1cfcb717af91e41ffb84b5fd851505682c576ee/transnetv2.onnx",
  sha256: "c4d54a682bace32f25136ef83ca2c9d403e8f8193775efeb995172a0d95a8e0c",
};
/** What a file's cuts were found by when the model found them (asset_versions.cuts_by; NULL: cutsOf). */
export const CUTS_BY_MODEL = "transnetv2";
/** The model's frames: this small, RGB (ffmpeg's default scale, as upstream reads them) */
export const TW = 48;
export const TH = 27;
const FRAME = TW * TH * 3;
/** It looks at WIN frames at once and answers for the middle NEW (upstream's windowing: PAD on each side) */
const WIN = 100;
const NEW = 50;
const PAD = 25;
/** A frame is in a transition when either of its two outputs (one frame / all frames of a transition) passes this */
const AT = 0.5;
/** Two cuts this close (s) are one, and none this near either end: as look.ts cutsOf */
const MIN_SHOT_S = 0.3;

/**
 * The model on this computer's graphics card for one read, or null where it can't run there fast: only Linux with an
 * NVIDIA card and the CUDA 12 and cuDNN 9 libraries onnxruntime loads. Opened per read and released after it, so the
 * card is free between files (and a process never ends holding it: onnxruntime-node crashes on exit then). A card
 * that can't open it is not asked again until the app restarts. CT_CUT_MODEL=0 keeps cutsOf everywhere.
 */
export async function cutModel(): Promise<InferenceSession | null> {
  if (cannot || process.env.CT_CUT_MODEL === "0" || process.platform !== "linux" || !existsSync("/proc/driver/nvidia/version")) return null;
  try {
    const ort = await import("onnxruntime-node");
    return await ort.InferenceSession.create(await modelBytes(TRANSNET), { executionProviders: ["cuda"] });
  } catch (e) {
    cannot = true;
    console.warn(`[library] the graphics card can't run the cut model, cuts are measured: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
let cannot = false;

/** The frames where a new shot starts, from the model's per-frame probabilities: one per transition, the frame after
 * its most likely one (a hard cut marks the old shot's last frame). */
export function cutsFromModel(one: ArrayLike<number>, many: ArrayLike<number>, fps: number): number[] {
  const n = one.length;
  const p = (i: number) => Math.max(one[i]!, many[i]!);
  const cuts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (p(i) <= AT) continue;
    let top = i;
    for (; i + 1 < n && p(i + 1) > AT; i++) if (p(i + 1) > p(top)) top = i + 1;
    const at = top + 1;
    if (at < MIN_SHOT_S * fps || n - at < MIN_SHOT_S * fps) continue;
    const last = cuts[cuts.length - 1];
    if (last !== undefined && at - last < MIN_SHOT_S * fps) continue;
    cuts.push(at);
  }
  return cuts;
}

/**
 * Feeds TW×TH RGB frames as they are decoded through the model, a window each NEW frames, one window at a time;
 * `end` pads the last window and gives every frame's two probabilities.
 */
export function modelWindows(session: InferenceSession) {
  const frames: Buffer[] = []; // the frames from `base` on, as many as the next window needs
  let base = 0;
  let n = 0;
  let next = 0; // the next window: its first frame is next*NEW - PAD
  let first: Buffer | undefined;
  const one: number[] = [];
  const many: number[] = [];
  let chain: Promise<void> = Promise.resolve();
  const at = (i: number) => (i < 0 ? first! : frames[Math.min(i, n - 1) - base]!);
  const run = (k: number) => {
    const x = new Float32Array(WIN * FRAME);
    for (let j = 0; j < WIN; j++) {
      const f = at(k * NEW - PAD + j);
      for (let b = 0; b < FRAME; b++) x[j * FRAME + b] = f[b]!;
    }
    chain = chain.then(async () => {
      const ort = await import("onnxruntime-node");
      const out = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", x, [1, WIN, TH, TW, 3]) });
      const [a, b] = session.outputNames.map((o) => out[o]!.data as Float32Array);
      for (let j = PAD; j < PAD + NEW; j++) one.push(a![j]!), many.push(b![j]!);
    });
    chain.catch(() => {}); // a failed run is thrown by `end`, never left unhandled until then
  };
  return {
    push(f: Buffer) {
      first ??= f;
      frames.push(f);
      n++;
      while (n >= next * NEW + WIN - PAD) {
        run(next++);
        const keep = next * NEW - PAD; // the first frame the next window looks at
        if (keep > base) frames.splice(0, keep - base), (base = keep);
      }
    },
    async end(): Promise<{ one: number[]; many: number[] }> {
      while (next * NEW < n) run(next++);
      await chain;
      return { one: one.slice(0, n), many: many.slice(0, n) };
    },
  };
}
