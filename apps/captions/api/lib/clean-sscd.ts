import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InferenceSession } from "onnxruntime-node";
import type {
  Measurement,
  SscdStats,
} from "../../contracts/clean-fingerprints";
import { readPpm, resizeRgb, type RgbImage } from "./clean-visual-math";

export const SSCD_SHA256 =
  "831a55f045850936bc0f5e7437dd6cd54351cfd7d066fd5e1ac7e2eacbc1d13b";
const modelPath = () =>
  path.resolve(process.env.SSCD_MODEL_PATH || "runtime/sscd/sscd.onnx");
let session: Promise<InferenceSession> | undefined;
let tail = Promise.resolve();
let pending = 0;
async function loadSession() {
  if (!session)
    session = (async () => {
      const bytes = await readFile(modelPath());
      if (createHash("sha256").update(bytes).digest("hex") !== SSCD_SHA256)
        throw new Error(
          "SSCD model checksum does not match the verified model.",
        );
      const ort = await import("onnxruntime-node");
      return ort.InferenceSession.create(bytes, {
        executionProviders: ["cpu"],
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      });
    })().catch((error) => {
      session = undefined;
      throw error;
    });
  return session;
}

export async function sscdAvailable() {
  return access(modelPath()).then(
    () => true,
    () => false,
  );
}

/** One inference at a time, bounded waiting, abort checked before every frame.
 * Native inference already in flight finishes one frame; obsolete jobs never start another. */
export async function sscdDescriptor(
  image: RgbImage,
  signal?: AbortSignal,
): Promise<number[]> {
  signal?.throwIfAborted();
  if (pending >= 8) throw new Error("SSCD is busy. Try again shortly.");
  pending++;
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    signal?.throwIfAborted();
    const model = await loadSession();
    signal?.throwIfAborted();
    const rgb = resizeRgb(image, 320),
      tensor = new Float32Array(rgb.length);
    const mean = [0.485, 0.456, 0.406],
      std = [0.229, 0.224, 0.225];
    for (let i = 0; i < 320 * 320; i++)
      for (let c = 0; c < 3; c++)
        tensor[c * 320 * 320 + i] = (rgb[i * 3 + c] - mean[c]) / std[c];
    const ort = await import("onnxruntime-node");
    const output = await model.run({
      image: new ort.Tensor("float32", tensor, [1, 3, 320, 320]),
    });
    signal?.throwIfAborted();
    const descriptor = Array.from(output.descriptor.data as Float32Array);
    const norm = Math.hypot(...descriptor);
    if (descriptor.length !== 512 || !Number.isFinite(norm) || norm < 0.001)
      throw new Error("SSCD returned an invalid descriptor.");
    return descriptor.map((v) => v / norm);
  } finally {
    pending--;
    release();
  }
}

export async function measureSscdPairs(
  pairs: { before: string; after: string; cache?: string }[],
  signal?: AbortSignal,
): Promise<Measurement<SscdStats>> {
  if (!(await sscdAvailable()))
    return {
      status: "unavailable",
      message: "SSCD model is not installed on this server.",
    };
  try {
    const scores: number[] = [];
    for (const pair of pairs) {
      signal?.throwIfAborted();
      let before: number[] | undefined;
      if (pair.cache) {
        const cached = JSON.parse(
          await readFile(pair.cache, "utf8").catch(() => "null"),
        );
        if (
          cached?.model === SSCD_SHA256 &&
          Array.isArray(cached.descriptor) &&
          cached.descriptor.length === 512 &&
          cached.descriptor.every(Number.isFinite)
        )
          before = cached.descriptor;
      }
      if (!before) {
        before = await sscdDescriptor(
          readPpm(await readFile(pair.before)),
          signal,
        );
        if (pair.cache) {
          const temporary = pair.cache + "." + randomUUID();
          await writeFile(
            temporary,
            JSON.stringify({ model: SSCD_SHA256, descriptor: before }),
            { mode: 0o600 },
          );
          await rename(temporary, pair.cache);
        }
      }
      const after = await sscdDescriptor(
        readPpm(await readFile(pair.after)),
        signal,
      );
      scores.push(
        Math.max(
          -1,
          Math.min(
            1,
            before.reduce((sum, v, i) => sum + v * after[i], 0),
          ),
        ),
      );
    }
    if (!scores.length) throw new Error("No SSCD frame pairs were decoded.");
    return {
      status: "ok",
      model: "sscd_disc_mixup",
      modelSha256: SSCD_SHA256,
      pairs: scores.length,
      meanSimilarity: scores.reduce((a, b) => a + b, 0) / scores.length,
      minSimilarity: Math.min(...scores),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      status: "error",
      message:
        error instanceof Error ? error.message : "SSCD measurement failed.",
    };
  }
}
