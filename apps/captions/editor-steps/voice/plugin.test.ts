import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { ffmpeg } from "../../api/library/media/run";
import { cleanVoices, voiceFilter } from "./plugin";

const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "voice-step-"));
const probe = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { encoding: "utf8" }));

describe("the Voice step", () => {
  it("cleans the voice of a take into a copy with the same picture, length and timecode, and leaves B-roll alone", async () => {
    const take = path.join(dir, "take.mov");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "anoisesrc=d=2:a=0.05",
      "-map", "0", "-map", "1", "-c:v", "mpeg4", "-c:a", "aac", "-timecode", "01:00:10:00", "-shortest", take]);
    const timeline = {
      sources: { t: { w: 320, h: 240 }, b: { w: 320, h: 240 } },
      tracks: { A1: { items: [{ src: "t" }] }, V2: { items: [{ src: "b" }] } },
    } as unknown as Timeline;
    const input = { edit: { id: "e", name: "E", createdBy: "me" }, variant: "", files: { t: take, b: take }, timeline, values: { noise: "light" }, workDir: dir, signal: new AbortController().signal };
    const out = await cleanVoices(input);
    expect(Object.keys(out)).toEqual(["t"]);
    const before = probe(take);
    const after = probe(out.t!);
    const video = (p: { streams: { codec_type: string }[] }) => p.streams.find((s) => s.codec_type === "video") as Record<string, unknown>;
    expect(video(after).codec_name).toBe(video(before).codec_name);   // the picture copied, not encoded again
    expect(video(after).nb_frames).toBe(video(before).nb_frames);
    expect(after.streams.find((s: { codec_type: string }) => s.codec_type === "audio").codec_name).toBe("pcm_s24le");
    expect(JSON.stringify(after)).toContain("01:00:10:00");   // the timecode, so every cut stays where it is
    expect(await cleanVoices(input)).toEqual(out);   // the same copy again: nothing made twice
  });

  it("levels only when noise removal is off", () => {
    expect(voiceFilter("off")).toBe("highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(voiceFilter("strong")).toContain("afftdn=nr=20");
  });
});
