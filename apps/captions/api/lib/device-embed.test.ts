import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "device-embed-"));
process.env.DATA_DIR = dir;
const pcm = path.join(dir, "speech.f32");
writeFileSync(pcm, Buffer.from(new Float32Array(16000).buffer));
const { deviceEmbedStatus, embedOnDevice, GETTING_SEARCH_MODEL } = await import("./device-embed");
const { transcribeOnDevice } = await import("./device-transcribe");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const order: string[] = [];
let loaded = false;
/** A stand-in for the search model: each text becomes (texts in its run, 1); it says it is being fetched while it loads. */
const load = async (say: (text: string) => void) => {
  say(GETTING_SEARCH_MODEL);
  order.push(`fetching: ${deviceEmbedStatus("ver-1")}`);
  loaded = true;
  const m = async (texts: string[]) => ({ data: Float32Array.from(texts.flatMap(() => [texts.length, 1])), dims: [texts.length, 2] });
  return Object.assign(m, { dispose: async () => void ((loaded = false), order.push("search model given back")) });
};

it("a clip's vectors in order; the speech model loads only once the search model is given back, and a search waits for words alone", async () => {
  expect(await embedOnDevice(["a", "b"], { key: "ver-1" }, load)).toEqual([Float32Array.from([2, 1]), Float32Array.from([2, 1])]);
  expect(deviceEmbedStatus("ver-1")).toBeUndefined();
  let search: Promise<unknown> | undefined;
  await transcribeOnDevice(pcm, "clip", async () => {
    order.push(`speech model loads, search model ${loaded ? "still in memory" : "out"}`);
    search = embedOnDevice(["query"], undefined, load);
    throw new Error("stop here");
  }).catch(() => {});
  await expect(search).rejects.toThrow("This computer is making a transcript");
  expect(order).toEqual([`fetching: ${GETTING_SEARCH_MODEL}`, "search model given back", "speech model loads, search model out"]);
});
