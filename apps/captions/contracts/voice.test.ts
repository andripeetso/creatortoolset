import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { SPEECH_REASONS, STT_MODELS, speechReasonLine } from "./voice";

// The Linux helper (public/helper/helper.py) keeps its own map of what to download: it must be the catalog's.
it("the helper downloads exactly the catalog's computer models, from their `download` repositories", () => {
  const py = readFileSync(path.join(import.meta.dirname, "../public/helper/helper.py"), "utf-8");
  const block = /CATALOG = \{([\s\S]*?)\n\}/.exec(py)![1]!;
  const helper = Object.fromEntries([...block.matchAll(/"([^"]+)": \("([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const catalog = Object.fromEntries(STT_MODELS.filter((m) => m.computer && m.download).map((m) => [m.id, m.download]));
  expect(helper).toEqual(catalog);
});

// The Mac app keeps its own list too (it dictates with no server): its ids and Core ML folders must be the catalog's.
it("the Mac app runs exactly the catalog's `coreml` models, under the same ids", () => {
  const swift = readFileSync(path.join(import.meta.dirname, "../../mac/Sources/CreatorToolsetMac/Dictation/Whisper.swift"), "utf-8");
  const block = /static let shared: \[TranscriptionModel\] = \[([\s\S]*?)\n {4}\]/.exec(swift)![1]!;
  const mac = Object.fromEntries(block.split("TranscriptionModel(").slice(1).map((e) => [
    /id: "([^"]+)"/.exec(e)![1], /(?:whisperKitID|parakeet): (?:onThisChip\()?"([^"]+)"/.exec(e)![1],
  ]));
  const catalog = Object.fromEntries(STT_MODELS.filter((m) => m.coreml).map((m) => [m.id, m.coreml]));
  expect(Object.keys(mac).length).toBeGreaterThan(0);
  expect(mac).toEqual(catalog);
  // every one a computer downloads: a Mac's has no `computer`-less entry, and each has a source
  for (const m of STT_MODELS.filter((x) => x.computer)) expect(m.download || m.coreml, m.id).toBeTruthy();
});

it("every speech reason has its sentence, with the next step, and names the engine only when it has one", () => {
  for (const reason of SPEECH_REASONS) expect(speechReasonLine(reason)).toMatch(/\.$/);
  expect(speechReasonLine("missing-key", "deepgram")).toBe("Add your Deepgram key in Settings → API keys.");
  expect(speechReasonLine("rejected-key", "openai")).toBe("OpenAI rejected the key. Check it in Settings → API keys.");
  expect(speechReasonLine("unavailable")).toBe("Could not write this down. Try again.");
  expect(speechReasonLine("computer-off", "local")).toMatch(/computers/);
});
