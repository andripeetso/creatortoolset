import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const expected =
  "831a55f045850936bc0f5e7437dd6cd54351cfd7d066fd5e1ac7e2eacbc1d13b";
const [output = "runtime/sscd", cache] = process.argv.slice(2);
if (!cache)
  throw new Error(
    "Pass a verified SSCD cache directory. See docs/video-cleaner/README.md.",
  );
const bytes = await readFile(path.join(cache, "sscd.onnx"));
if (createHash("sha256").update(bytes).digest("hex") !== expected)
  throw new Error("SSCD model checksum mismatch");
await mkdir(output, { recursive: true });
for (const name of ["sscd.onnx", "manifest.json", "parity.json"])
  await copyFile(path.join(cache, name), path.join(output, name));
await copyFile(
  new URL("./sscd-LICENSE.txt", import.meta.url),
  path.join(output, "LICENSE.txt"),
);
console.log("Installed verified SSCD model");
