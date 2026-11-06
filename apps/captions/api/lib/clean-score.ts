import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { EditOptions } from "../../contracts/clean-edit";
import type { QuickScore } from "../../contracts/clean-fingerprints";
import {
  editTimeline,
  sourceMoment,
  timelineDuration,
} from "../../contracts/clean-timeline";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { editFilters } from "./clean-edit";
import { averageVisual, readPpm, visualDifference } from "./clean-visual-math";
import { measureSscdPairs, sscdAvailable } from "./clean-sscd";
import {
  parsePdq,
  pdqDistance,
  runFingerprintTool,
  summarizePdq,
} from "./clean-fingerprints";

/** Only small source frames survive requests; no adjusted video or frame is retained. */
export async function quickScore(
  input: string,
  options: EditOptions,
  info: { width: number; height: number; duration: number },
  signal: AbortSignal,
  mode: "score" | "sscd" = "score",
): Promise<QuickScore> {
  const began = performance.now();
  const timeline = editTimeline(options.adjustments, info.duration);
  const duration = timelineDuration(timeline);
  const result: QuickScore = {
    measuredAt: Date.now(),
    elapsedMs: 0,
    cachedFrames: 0,
    outputDuration: duration,
    scenes: timeline.length,
    pdq:
      mode === "sscd"
        ? {
            status: "unavailable",
            message: "PDQ is returned by the independent fast-score request.",
          }
        : { status: "error", message: "Scoring did not finish." },
  };
  const hasher = path.resolve(
    process.env.FINGERPRINT_BIN_DIR || "runtime/fingerprints",
    "pdq-photo-hasher",
  );
  if (mode === "sscd" && !(await sscdAvailable()))
    return {
      ...result,
      sscd: {
        status: "unavailable",
        message: "SSCD model is not installed on this server.",
      },
    };
  if (
    mode === "score" &&
    !(await access(hasher).then(
      () => true,
      () => false,
    ))
  )
    return {
      ...result,
      pdq: {
        status: "unavailable",
        message: "PDQ tools are not installed on this server.",
      },
    };
  const root = path.join(
    path.dirname(input),
    mode === "sscd" ? ".sscd-cache" : ".score-cache",
  );
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "run-"));
  const run = (cmd: string, args: string[]) =>
    runFingerprintTool(cmd, args, dir, 120_000, signal);
  const scale = Math.min(1, 768 / Math.max(info.width, info.height));
  const width = Math.max(2, Math.floor((info.width * scale) / 2) * 2),
    height = Math.max(2, Math.floor((info.height * scale) / 2) * 2);
  const count = Math.min(4, Math.max(1, Math.ceil(duration)));
  const times = Array.from(
    { length: count },
    (_, i) => (duration * (i + 0.5)) / count,
  );
  const originals: ReturnType<typeof parsePdq>[] = [];
  const sourceTimes: number[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const seconds = sourceMoment(
        timeline,
        times[i],
        options.adjustments.speed,
      );
      sourceTimes.push(seconds);
      const key = Math.round(seconds * 1000000).toString();
      const image = path.join(root, key + ".ppm"),
        json = path.join(root, key + ".json");
      let hash: ReturnType<typeof parsePdq> | undefined;
      try {
        hash = JSON.parse(await readFile(json, "utf8"));
        await access(image);
      } catch {
        hash = undefined;
      }
      if (!hash) {
        await run(ffmpegCommand(), [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-ss",
          String(seconds),
          "-i",
          input,
          "-map",
          "0:V:0",
          "-frames:v",
          "1",
          "-vf",
          `scale=${width}:${height}:flags=bicubic,setsar=1`,
          "-pix_fmt",
          "rgb24",
          "-update",
          "1",
          "cache.ppm",
        ]);
        await run(ffmpegCommand(), [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-i",
          "cache.ppm",
          "-vf",
          "scale=512:512:flags=bicubic",
          "-frames:v",
          "1",
          "-update",
          "1",
          "baseline.ppm",
        ]);
        hash =
          mode === "score"
            ? parsePdq(await run(hasher, ["baseline.ppm"]))
            : { hash: "", quality: 0 };
        signal.throwIfAborted();
        await rename(path.join(dir, "cache.ppm"), image);
        await writeFile(json, JSON.stringify(hash));
      } else result.cachedFrames++;
      originals.push(hash);
      await link(image, path.join(dir, `${i}.ppm`));
    }
    const filters = editFilters(options.adjustments, width, height);
    filters.push("scale=512:512:flags=bicubic", "format=rgb24");
    await run(ffmpegCommand(), [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-framerate",
      "1",
      "-start_number",
      "0",
      "-i",
      "%d.ppm",
      "-vf",
      filters.join(","),
      "-frames:v",
      String(count),
      "-start_number",
      "0",
      "after-%d.ppm",
    ]);
    // Baseline frames use the same square scaling as the adjusted frames.
    await run(ffmpegCommand(), [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-framerate",
      "1",
      "-start_number",
      "0",
      "-i",
      "%d.ppm",
      "-vf",
      "scale=512:512:flags=bicubic,format=rgb24",
      "-frames:v",
      String(count),
      "-start_number",
      "0",
      "before-%d.ppm",
    ]);
    const pairs = times.map((_, i) => ({
      before: path.join(dir, `before-${i}.ppm`),
      after: path.join(dir, `after-${i}.ppm`),
      cache: path.join(
        root,
        `${Math.round(sourceTimes[i] * 1000000)}.sscd.json`,
      ),
    }));
    if (mode === "sscd") {
      result.sscd = await measureSscdPairs(pairs, signal);
      result.elapsedMs = Math.round(performance.now() - began);
      return result;
    }
    result.visual = {
      status: "ok",
      ...averageVisual(
        await Promise.all(
          pairs.map(async (pair) =>
            visualDifference(
              readPpm(await readFile(pair.before)),
              readPpm(await readFile(pair.after)),
            ),
          ),
        ),
      ),
    };
    const hashes = (
      await run(
        hasher,
        times.map((_, i) => `after-${i}.ppm`),
      )
    )
      .trim()
      .split(/\r?\n/)
      .map(parsePdq);
    if (hashes.length !== count)
      throw new Error("PDQ returned an incomplete sample.");
    result.pdq = {
      status: "ok",
      ...summarizePdq(
        hashes.map((after, i) => ({
          seconds: times[i],
          originalSeconds: sourceTimes[i],
          before: originals[i].hash,
          after: after.hash,
          qualityBefore: originals[i].quality,
          qualityAfter: after.quality,
          distance: pdqDistance(originals[i].hash, after.hash),
          reliable: originals[i].quality >= 50 && after.quality >= 50,
        })),
      ),
    };
    result.elapsedMs = Math.round(performance.now() - began);
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
    // Bound the per-session cache, including when cuts change the sampled moments.
    const files = await Promise.all(
      (await readdir(root))
        .filter((f) => /^\d+\.ppm$/.test(f))
        .map(async (name) => ({
          name,
          time: (await stat(path.join(root, name))).mtimeMs,
        })),
    );
    for (const { name } of files.sort((a, b) => b.time - a.time).slice(32)) {
      await rm(path.join(root, name), { force: true });
      await rm(path.join(root, name.replace(".ppm", ".json")), { force: true });
      await rm(path.join(root, name.replace(".ppm", ".sscd.json")), {
        force: true,
      });
    }
  }
}
