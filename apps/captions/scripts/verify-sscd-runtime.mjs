import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-node";

const root = new URL("../runtime/sscd/", import.meta.url);
const bytes = await readFile(new URL("sscd.onnx", root));
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  "831a55f045850936bc0f5e7437dd6cd54351cfd7d066fd5e1ac7e2eacbc1d13b",
);
const sample = JSON.parse(await readFile(new URL("parity.json", root), "utf8"));
const session = await ort.InferenceSession.create(bytes, {
  executionProviders: ["cpu"],
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
});
try {
  const start = performance.now();
  const result = await session.run({
    image: new ort.Tensor(
      "float32",
      Float32Array.from(sample.image),
      [1, 3, 320, 320],
    ),
  });
  const actual = Array.from(result.descriptor.data);
  assert.equal(actual.length, 512);
  assert.ok(actual.every(Number.isFinite));
  const maxError = Math.max(
    ...actual.map((v, i) => Math.abs(v - sample.descriptor[i])),
  );
  assert.ok(maxError < 0.0001, `ONNX/TorchScript parity error ${maxError}`);
  assert.ok(Math.abs(Math.hypot(...actual) - 1) < 0.00001);
  console.log(
    `SSCD runtime OK: 512 dimensions, TorchScript parity error ${maxError}, ${Math.round(performance.now() - start)} ms/frame`,
  );
} finally {
  await session.release();
}
