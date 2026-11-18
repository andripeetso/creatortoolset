import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BlendInput, EnhanceInput, EnhanceMade } from "../../enhance";
import { env } from "../../lib/env";
import { readWav, SR, studioVoice, wav16 } from "../../lib/nvidia-voice";
import { probe } from "../../library/media/probe";
import { ffmpeg, ffmpegTo, withSignal } from "../../library/media/run";
import { taskKind } from "../tasks";

/**
 * The Audio Enhancer's built-in passes (api/enhance.ts), by the same code on a computer and on the server: the sound is
 * cut here, each engine call goes through the server on the owner's key (decision 12: `calls`, the sound up and the
 * clean sound back), then the loudness, the AAC and the video remux are made here too. The server files what it made.
 * The tool is loaded when it is needed: task-kinds.ts loads with the AI Editor's worker, which the tool's imports reach.
 */
const tool = () => import("../../enhance");
const session = (id: string, name: string) => path.join(env.dataDir, "enhance", id, name);

const b64 = (b: Buffer) => b.toString("base64");
const bytes = (v: unknown) => Buffer.from(String(v ?? ""), "base64");
/** The sound a call carries (base64 in its JSON). */
const sound = (body: unknown) => bytes((body as { wav?: unknown } | null)?.wav);

/** A LAME-style MP3 opens with 1105 samples of encoder delay that a decoder without the LAME tag plays, so the track runs past the input (~37 ms here). Decode it to WAV without the delay, at the input's length. */
const MP3_ENCODER_DELAY = 1105;
async function trimEncoderDelay(mp3: string, inputSeconds: number): Promise<string> {
  if (!mp3.endsWith(".mp3") || (await probe(mp3)).duration <= inputSeconds + 0.01) return mp3;
  const wav = mp3.replace(/\.mp3$/, ".wav");
  await ffmpeg(["-i", mp3, "-af", `atrim=start_sample=${MP3_ENCODER_DELAY},asetpts=PTS-STARTPTS`, "-t", String(inputSeconds), "-c:a", "pcm_s16le", wav]);
  await rm(mp3, { force: true });
  return wav;
}

taskKind<EnhanceInput, EnhanceMade>("enhance", {
  // the upload, a plug-in engine's pass before this one, and the sound its last pass left (enhance.ts originalPath,
  // passOut, finishInput)
  serve: (t, name) =>
    name === "original" ? session(t.ref, "original")
    : name === "pass" ? session(t.ref, `pass-${(t.input as EnhanceInput).step - 1}.wav`)
    : name === "clean" ? session(t.ref, "finish-in")
    : undefined,
  async run(input, ctx) {
    const { band, builtinEngine, LOUDNESS } = await tool();
    const original = await ctx.file("original");
    // finish: only the last steps, on what a plug-in engine's run left
    let clean = input.finish ? await ctx.file("clean") : input.step ? await ctx.file("pass") : original;
    return withSignal(ctx.signal, async () => {
      const out = (n: string) => path.join(ctx.dir, n);
      const progress = (p: number) => ctx.call("progress", { run: input.run, p }).catch(() => {});
      const p = await probe(original).catch(() => null);
      if (!p?.acodec) throw new Error("This file has no audio track");
      // attached cover art is a video stream too — require a real codec
      const hasVideo = !!p.vcodec && !p.cover && !["mjpeg", "png", "bmp"].includes(p.vcodec.toLowerCase());
      const files: string[] = [];
      if (input.source) {
        // the A/B source at the result's loudness: the comparison and the strength slider move the sound, not the volume
        await ffmpegTo(out("source.m4a"), ["-i", original, "-vn", "-af", LOUDNESS, "-ar", "48000", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-f", "mp4"]);
        files.push("source.m4a");
      }
      const n = input.chain.length;
      let k = input.finish ? n : input.step;
      for (; k < n && builtinEngine(input.chain[k]!); k++) {
        const engine = input.chain[k]!;
        const [lo, hi] = band(k, n);
        // mono PCM WAV for the engine: 48 kHz for NVIDIA, 44.1 kHz for ElevenLabs
        const wav = out(`in-${k}.wav`);
        await ffmpegTo(wav, ["-i", clean, "-vn", "-ac", "1", "-ar", engine === "nvidia" ? String(SR) : "44100", "-c:a", "pcm_s16le"]);
        await progress(lo);
        if (engine === "nvidia") {
          const y = await studioVoice(async (piece) => bytes(await ctx.call("nvidia", { wav: b64(piece) })), readWav(await readFile(wav)).x, ctx.signal, (done, total) => void progress(lo + (done / total) * (hi - lo)));
          clean = out(`nv-${k}.wav`);
          await writeFile(clean, wav16(y));
        } else {
          const got = (await ctx.call("elevenlabs", { wav: b64(await readFile(wav)) })) as { ext?: unknown; audio?: unknown };
          clean = out(`el-${k}.${/^[a-z0-9]{2,4}$/.test(String(got.ext)) ? got.ext : "mp3"}`);
          await writeFile(clean, bytes(got.audio));
          clean = await trimEncoderDelay(clean, (await probe(wav)).duration);
        }
        if (k + 1 < n) {
          // the next pass starts from this one
          const next = out(`pass-${k}.wav`);
          await ffmpegTo(next, ["-i", clean, "-ac", "1", "-ar", String(SR), "-c:a", "pcm_s16le", "-f", "wav"]);
          clean = next;
        }
      }
      if (k < n) {
        // a plug-in engine's pass is next: it takes this pass's sound (or the upload) on the server
        if (k > input.step) {
          await rename(clean, out("pass.wav"));
          files.push("pass.wav");
        }
        return { result: { duration: p.duration, hasVideo, next: k }, files };
      }
      // loudness, AAC, the video remux
      await progress(0.84);
      await ffmpegTo(out("enhanced.m4a"), ["-i", clean, "-af", LOUDNESS, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4"]);
      files.push("enhanced.m4a");
      let videoOutExt: "mp4" | "mkv" | undefined;
      if (hasVideo) {
        await progress(0.92);
        // the untouched video stream with the clean track, stream copy: mp4 first, mkv holds any codec; neither fails the run
        for (const ext of ["mp4", "mkv"] as const) {
          const name = `enhanced-video.${ext}`;
          const args = ["-i", original, "-i", out("enhanced.m4a"), "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest"];
          if (await ffmpegTo(out(name), [...args, ...(ext === "mp4" ? ["-movflags", "+faststart", "-f", "mp4"] : ["-f", "matroska"])]).then(() => true, () => false)) {
            videoOutExt = ext;
            files.push(name);
            break;
          }
        }
      }
      return { result: { duration: p.duration, hasVideo, ...(videoOutExt ? { videoOutExt } : {}) }, files };
    });
  },
  calls: {
    progress: async (t, body) => (await tool()).enhanceProgress(t.ref, t.input.run, Number((body as { p?: unknown } | null)?.p)),
    nvidia: async (t, body) => b64(await (await tool()).voicePiece(t.ref, t.actor || undefined, sound(body))),
    elevenlabs: async (t, body) => {
      const got = await (await tool()).isolate(t.ref, t.actor || undefined, sound(body));
      return { ext: got.ext, audio: b64(got.audio) };
    },
  },
  apply: async (t, made, files) => (await tool()).enhanceFiled(t.ref, t.input.run, made, files),
  failed: (t, error) => void tool().then((e) => e.enhanceFailed(t.ref, t.input.run, error)),
});

/** The download at a strength under 100 % (enhance.ts startBlend): the levelled original and the result mixed, and with `ext` the video remuxed with it. */
taskKind<BlendInput, null>("enhance-blend", {
  serve: (t, name) => {
    const id = (t.input as BlendInput).id;
    return name === "source" ? session(id, "source.m4a") : name === "enhanced" ? session(id, "enhanced.m4a") : name === "original" ? session(id, "original") : undefined;
  },
  async run(input, ctx) {
    const { LOUDNESS } = await tool();
    const [source, enhanced] = [await ctx.file("source"), await ctx.file("enhanced")];
    const original = input.ext ? await ctx.file("original") : "";
    return withSignal(ctx.signal, async () => {
      const blend = path.join(ctx.dir, "blend.m4a");
      const mix = `[0:a]volume=${(100 - input.pct) / 100}[o];[1:a]volume=${input.pct / 100}[e];[o][e]amix=inputs=2:normalize=0:duration=longest,${LOUDNESS}`;
      await ffmpegTo(blend, ["-i", source, "-i", enhanced, "-filter_complex", mix, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4"]);
      if (!input.ext) return { result: null, files: ["blend.m4a"] };
      const video = `blend-video.${input.ext}`;
      await ffmpegTo(path.join(ctx.dir, video), ["-i", original, "-i", blend, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", ...(input.ext === "mp4" ? ["-movflags", "+faststart", "-f", "mp4"] : ["-f", "matroska"])]);
      return { result: null, files: ["blend.m4a", video] };
    });
  },
  apply: async (t, _r, files) => (await tool()).enhanceBlended(t.input, files),
});
