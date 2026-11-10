import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "device-transcribe-"));
process.env.DATA_DIR = dir;
const pcm = path.join(dir, "speech.f32");
writeFileSync(pcm, Buffer.from(new Float32Array(16000).buffer)); // one second of silence, as ffmpeg's DEVICE_AUDIO writes it
const { deviceStatus, deviceTranscribes, LISTENING, transcribeOnDevice, wordsOf } = await import("./device-transcribe");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.CT_LOCAL;
  delete process.env.CT_MODE;
});

/** A stand-in for the loaded model: it "hears" Estonian, and records what each run was asked and what was showing. */
function fakeModel() {
  const runs: { samples: number; options: Record<string, unknown>; status?: string }[] = [];
  let open = 0;
  let most = 0;
  let closed = 0;
  const load = async () => {
    const model = async (samples: Float32Array, options: Record<string, unknown>) => {
      most = Math.max(most, ++open);
      runs.push({ samples: samples.length, options, status: deviceStatus(`clip-${runs.length + 1}`) });
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return { chunks: [{ text: " Tere", timestamp: [0.2, 0.5] as [number, number] }] };
    };
    return Object.assign(model, {
      dispose: async () => void closed++,
      processor: async () => ({ input_features: null }),
      model: {
        generation_config: { is_multilingual: true, decoder_start_token_id: 1, lang_to_id: { "<|en|>": 5, "<|et|>": 7 } },
        generate: async () => ({ data: [1, 7] }),
      },
    });
  };
  return { load, runs, most: () => most, closed: () => closed };
}

describe("transcripts made on this computer", () => {
  it("only a server on its owner's computer makes them, never a hosted one", () => {
    expect(deviceTranscribes()).toBe(false);
    process.env.CT_LOCAL = "1";
    expect(deviceTranscribes()).toBe(true);
    process.env.CT_MODE = "hosted";
    expect(deviceTranscribes()).toBe(false);
  });

  it("every word keeps its times, in order, and a word with no end still gets one", () => {
    expect(
      wordsOf([
        { text: " Hello,", timestamp: [0.28, 0.66] },
        { text: " ", timestamp: [0.7, 0.8] },
        { text: " week.", timestamp: [22.34, null] },
        { text: " this", timestamp: [0.88, 1.1] },
      ]),
    ).toEqual([
      { text: "Hello,", start: 0.28, end: 0.66 },
      { text: "this", start: 0.88, end: 1.1 },
      { text: "week.", start: 22.34, end: 22.59 },
    ]);
  });

  it("leaves out what the model makes up when nobody speaks: a word after the end, a half minute of words it could not place", () => {
    // as measured over music: the same two words again and again, most of them with no length
    const loop = Array.from({ length: 60 }, (_, i) => ({ text: i % 2 ? " -kichi," : " neko", timestamp: [30 + i * 0.3, 30 + i * 0.3 + (i % 5 ? 0 : 0.6)] as [number, number] }));
    const speech = "Today we practice a gentle warm up with the little ones. First we stretch our arms up high, then we roll slowly to the side."
      .split(" ")
      .map((text, i) => ({ text: ` ${text}`, timestamp: [i * 0.4, i * 0.4 + 0.3] as [number, number] }));
    const out = wordsOf([...speech, ...loop, { text: " you", timestamp: [64.5, 64.6] }], 60);
    expect(out.map((w) => w.text).join(" ")).toBe("Today we practice a gentle warm up with the little ones. First we stretch our arms up high, then we roll slowly to the side.");
  });

  it("hears the language instead of assuming English, asks for word times, and gives the memory back", async () => {
    const fake = fakeModel();
    const out = await transcribeOnDevice(pcm, "clip-1", fake.load);
    expect(out).toEqual({ words: [{ text: "Tere", start: 0.2, end: 0.5 }], language: "et" });
    expect(fake.runs[0]).toMatchObject({ samples: 16000, options: { return_timestamps: "word", language: "et", task: "transcribe" }, status: LISTENING });
    expect(fake.closed()).toBe(1);
    expect(deviceStatus("clip-1")).toBeUndefined(); // over: nothing left to show
  });

  it("a model that will not load fails in plain words, and the next run starts clean", async () => {
    const broken = async () => Promise.reject(new Error('Could not locate file: "http://server/api/hf/x/config.json"'));
    await expect(transcribeOnDevice(pcm, "clip-1", broken)).rejects.toThrow(/^The speech model could not be made ready\. It downloads once \(291 MB\)/);
    expect(deviceStatus("clip-1")).toBeUndefined();
    expect((await transcribeOnDevice(pcm, "clip-1", fakeModel().load)).words).toHaveLength(1);
  });

  it("runs one at a time, however many are asked for at once", async () => {
    const fake = fakeModel();
    await Promise.all([transcribeOnDevice(pcm, "clip-1", fake.load), transcribeOnDevice(pcm, "clip-2", fake.load), transcribeOnDevice(pcm, "clip-3", fake.load)]);
    expect(fake.runs).toHaveLength(3);
    expect(fake.most()).toBe(1);
  });
});
