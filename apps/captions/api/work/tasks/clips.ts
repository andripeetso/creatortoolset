import path from "node:path";
import type { NoteInput, NoteMade } from "../../clips";
import { env } from "../../lib/env";
import { probe } from "../../library/media/probe";
import { ffmpegTo, withSignal } from "../../library/media/run";
import { taskKind } from "../tasks";

/**
 * Video Notes (api/clips.ts): a recording's picture, length and sound, made where the recording is, by the same code on
 * a computer and on the server. The server files the picture and has the sound turned into words on the owner's key
 * (decision 12: the sound is cut here, the paid call is the server's); the notes are written from those words.
 * The tool is loaded when it is needed: task-kinds.ts loads with the AI Editor's worker, which the tool's imports reach.
 */
const tool = () => import("../../clips");

taskKind<NoteInput, NoteMade>("notes", {
  serve: (t, name) => (name === "recording" ? path.join(env.dataDir, "clips", t.ref, "recording") : undefined),
  async run(input, ctx) {
    const src = await ctx.file("recording");
    return withSignal(ctx.signal, async () => {
      const p = await probe(src).catch(() => null);
      const duration = p?.duration ?? 0;
      const files: string[] = [];
      // a recording with no picture (sound only) is no failure: it just has no thumbnail
      await ffmpegTo(path.join(ctx.dir, "thumb.jpg"), ["-ss", duration > 2 ? "1" : "0", "-i", src, "-frames:v", "1", "-q:v", "4"]).then(
        () => files.push("thumb.jpg"),
        () => {},
      );
      const audio = !!p?.acodec;
      if (input.sound && audio) {
        await ffmpegTo(path.join(ctx.dir, "sound"), ["-i", src, ...(input.sound === "device" ? (await import("../../lib/device-transcribe")).DEVICE_AUDIO : ["-vn", "-ac", "1", "-ar", "16000", "-f", "wav"])]);
        files.push("sound");
      }
      return { result: { duration, audio }, files };
    });
  },
  apply: async (t, made, files) => (await tool()).noteFiled(t.ref, made, files),
  failed: (t, error) => void tool().then((c) => c.noteFailed(t.ref, error)),
});
