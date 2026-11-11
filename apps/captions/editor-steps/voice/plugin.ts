import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { definePlugin, type EditorStepInput } from "../../api/lib/plugin";
import { ffmpegTo } from "../../api/library/media/run";

/**
 * Voice, an AI Editor step: the voice of each recording the cut plays on A1 cleaned (low rumble cut, steady noise
 * taken down) and levelled to one loudness, by the app's own ffmpeg, on this computer. The picture is copied as it is
 * and the copy keeps the file's timecode, so every cut stays where it is.
 */

const NOISE: Record<string, string> = { light: "afftdn=nr=10:nf=-40,", strong: "afftdn=nr=20:nf=-35,", off: "" };
export const voiceFilter = (noise: string) => `highpass=f=80,${NOISE[noise] ?? NOISE.light}loudnorm=I=-16:TP=-1.5:LRA=11`;

export async function cleanVoices({ files, timeline, values, workDir, signal }: EditorStepInput): Promise<Record<string, string>> {
  const filter = voiceFilter(values.noise ?? "light");
  const voices = new Set(timeline.tracks.A1.items.map((i) => i.src));
  const out: Record<string, string> = {};
  for (const id of voices) {
    const file = files[id];
    if (!file || signal.aborted) continue;
    const video = (timeline.sources[id]?.w ?? 0) > 0;
    // one copy per file, version of it and filter: a draft made again reuses it
    const key = createHash("sha1").update(`${file}\n${statSync(file).mtimeMs}\n${filter}`).digest("hex").slice(0, 12);
    const dest = path.join(workDir, `${id}-${key}.${video ? "mov" : "wav"}`);
    if (!existsSync(dest)) {
      await ffmpegTo(dest, [
        "-i", file,
        ...(video ? ["-map", "0:v:0", "-c:v", "copy"] : []),
        "-map", "0:a:0", "-af", filter, "-c:a", "pcm_s24le", "-ar", "48000",
        "-map_metadata", "0",
        "-f", video ? "mov" : "wav",
      ]);
    }
    out[id] = dest;
  }
  return out;
}

export default definePlugin({
  id: "editor-voice",
  name: "Voice",
  about: "Cleans and levels the voice in every edit, on this computer",
  editor: {
    steps: [
      {
        id: "voice",
        title: "Voice",
        about: "Cuts low rumble, takes down steady background noise and levels the voice to one loudness.",
        order: 40,
        options: [
          {
            id: "noise",
            label: "Noise removal",
            kind: "choice",
            default: "light",
            choices: [
              { value: "light", label: "Light" },
              { value: "strong", label: "Strong" },
              { value: "off", label: "Off (level only)" },
            ],
          },
        ],
        run: cleanVoices,
      },
    ],
  },
});
