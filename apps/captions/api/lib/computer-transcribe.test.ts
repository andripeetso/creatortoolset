import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TRANSCRIBE_KIND } from "../../contracts/devices";
import type { Device } from "../../contracts/providers";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "computer-transcribe-"));
process.env.APP_SECRET = "computer-transcribe-secret";
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { deviceOf, pairDevice, setDeviceKinds, setDeviceStt, touchDevice } = await import("./devices");
const { strongest, transcribeOnComputer, transcriptWaits, ComputerOff, COMPUTER_LIMITS, EDITOR_LIMITS } = await import("./computer-transcribe");
const { availableEngines, resolvedOne, speechFor, speechJob, writeVoicePrefs } = await import("./speech");
const { editorWordsFromComputer } = await import("../transcribe");
const { saveMyKey } = await import("../my-keys");

const ana = createUser("ana", "password1");
const key = `Bearer ${newApiKey(ana, "full")}`;
const json = (body: unknown, extra: Record<string, string> = {}, method = "POST") => ({ method, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const report = (token: string, machine: Record<string, unknown>) => app.request("/api/devices/relay/report", json({ drivers: [], homes: [], machine }, as(token)));
const claim = async (token: string, models: string[] = [], getting: string[] = [], asked: string[] = []) =>
  (await (await app.request("/api/devices/relay/editor/claim", json({ kinds: [TRANSCRIBE_KIND], models, getting, asked }, as(token)))).json()) as { job: { id: number; model: string } | null; models: string[] };
const voice = async () => (await (await app.request("/api/voice-prefs", { headers: { authorization: key } })).json()) as { computers: { name: string; models: { id: string; state: string }[] }[] };
const want = (computer: string, model: string, keep: boolean) => app.request("/api/voice-prefs/models", json({ computer, model, keep }, { authorization: key }, "PUT"));

// two computers of ana's: a Mac (no graphics card in its report) and a PC with a large one
const mac = pairDevice("ana", "Tiny Mac");
const pc = pairDevice("ana", "Tiny PC");
await report(mac.token, { os: "mac", cpus: 12, memGb: 32, freeGb: 16 });
await report(pc.token, { os: "linux", cpus: 32, memGb: 64, freeGb: 40, gpu: "RTX", gpuMemGb: 16 });

describe("which computer gets a transcript", () => {
  it("the strongest first: a graphics card before cores, a preference before both, Off last; no report still counts", () => {
    const d = (id: string, machine?: Record<string, unknown>) => ({ id, ...(machine ? { report: { machine } } : {}) }) as unknown as Device;
    const list = [d("bare"), d("mac", { cpus: 12, memGb: 32 }), d("pc", { cpus: 8, memGb: 32, gpuMemGb: 16 })];
    expect(strongest(list, {}).map((x) => x.id)).toEqual(["pc", "mac", "bare"]);
    expect(strongest(list, { mac: 100 }).map((x) => x.id)).toEqual(["mac", "pc", "bare"]);
    expect(strongest(list, { pc: 0 }).map((x) => x.id)).toEqual(["mac", "bare", "pc"]);
  });

  it("goes to the strongest computer that has the model; the Mac without it is never handed it", async () => {
    // both say what they have: the PC turbo, the Mac turbo and Parakeet
    expect((await claim(pc.token, ["whisper-large-v3-turbo"])).models).toEqual(["whisper-large-v3-turbo"]);
    await claim(mac.token, ["whisper-large-v3-turbo", "parakeet-tdt-0.6b-v3"]);
    const audio = path.join(process.env.DATA_DIR!, "a.wav");
    writeFileSync(audio, "RIFF-tiny");
    const done = transcribeOnComputer("ana", "whisper-large-v3-turbo", ["en"], audio);
    expect((await claim(mac.token, ["whisper-large-v3-turbo", "parakeet-tdt-0.6b-v3"])).job).toBeNull();
    const got = (await claim(pc.token, ["whisper-large-v3-turbo"])).job!;
    expect(got).toMatchObject({ kind: TRANSCRIBE_KIND, model: "whisper-large-v3-turbo", languages: ["en"] });
    // the audio only to the computer that holds it
    expect((await app.request(`/api/devices/relay/transcribe/${got.id}`, { headers: as(mac.token) })).status).toBe(404);
    expect(await (await app.request(`/api/devices/relay/transcribe/${got.id}`, { headers: as(pc.token) })).text()).toBe("RIFF-tiny");
    // what it sends back is checked before it ends the transcript
    expect((await app.request(`/api/devices/relay/transcribe/${got.id}`, json({ words: [{ text: "hi", start: 2, end: 1 }] }, as(pc.token)))).status).toBe(400);
    const sent = await app.request(`/api/devices/relay/transcribe/${got.id}`, json({ words: [{ text: " hello ", start: 0, end: 0.4 }], language: "en" }, as(pc.token)));
    expect(sent.status).toBe(200);
    expect(await done).toEqual({ words: [{ text: "hello", start: 0, end: 0.4 }], language: "en" });
    // Parakeet only the Mac has: it goes there
    const p = transcribeOnComputer("ana", "parakeet-tdt-0.6b-v3", [], audio);
    const failed = expect(p).rejects.toThrow("Out of memory");
    const j = (await claim(mac.token, ["whisper-large-v3-turbo", "parakeet-tdt-0.6b-v3"])).job!;
    expect(j.model).toBe("parakeet-tdt-0.6b-v3");
    await app.request(`/api/devices/relay/transcribe/${j.id}/fail`, json({ error: "Out of memory" }, as(mac.token)));
    await failed;
    // the AI Editor's never go to a Mac (its Core ML Parakeet drops fillers the editor cuts at): with only the Mac
    // holding Parakeet, an editor transcript says it waits for a computer, and the Mac is never handed it
    await expect(transcribeOnComputer("ana", "parakeet-tdt-0.6b-v3", ["en"], audio, EDITOR_LIMITS)).rejects.toBeInstanceOf(ComputerOff);
    expect(availableEngines("ana", "editor")).not.toContain("local");
    expect(availableEngines("ana", "captions")).toContain("local");
  });

  it("with no computer that has the model on, it waits and says for what", async () => {
    await expect(transcribeOnComputer("ana", "whisper-large-v3", [], "x.wav")).rejects.toBeInstanceOf(ComputerOff);
    await expect(transcribeOnComputer("ana", "whisper-large-v3", [], "x.wav")).rejects.toThrow("Waits for a computer with Whisper large-v3 to be on");
  });
});

describe("a transcript never waits for ever", () => {
  const audio = () => {
    const f = path.join(process.env.DATA_DIR!, "b.wav");
    writeFileSync(f, Buffer.alloc(32_000 * 60)); // a minute of audio
    return f;
  };
  const tick = (ms: number, keep: string[] = []) => vi.advanceTimersByTimeAsync(ms).then(() => keep.forEach(touchDevice));

  it("its computer goes off: it waits and says so", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await claim(pc.token, ["whisper-large-v3-turbo"]);
      const p = transcribeOnComputer("ana", "whisper-large-v3-turbo", [], audio());
      const off = expect(p).rejects.toBeInstanceOf(ComputerOff);
      await tick(60_000);
      await off;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a computer that is on but never claims it: it waits; one that claims and never answers: it fails, a try", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const both = [pc.device.id, mac.device.id];
    try {
      touchDevice(pc.device.id);
      const p = transcribeOnComputer("ana", "whisper-large-v3-turbo", [], audio());
      const waits = expect(p).rejects.toBeInstanceOf(ComputerOff);
      for (let t = 0; t <= COMPUTER_LIMITS.unclaimedMs; t += 15_000) await tick(15_000, both);
      await waits;
      const q = transcribeOnComputer("ana", "whisper-large-v3-turbo", [], audio());
      const slow = expect(q).rejects.toThrow("did not transcribe it in 10 minutes");
      expect((await claim(pc.token, ["whisper-large-v3-turbo"])).job).not.toBeNull();
      for (let t = 0; t <= COMPUTER_LIMITS.takeMs; t += 15_000) await tick(15_000, both);
      await slow;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("speechFor with computers", () => {
  it("local with no model chosen: the first model a computer that is on has, that hears the person's languages", () => {
    writeVoicePrefs("ana", { stt: { default: { engine: "local" } } });
    // Estonian: Parakeet hears English only, so turbo
    writeVoicePrefs("ana", { languages: ["et"] });
    expect(speechFor("ana", "transcripts")).toMatchObject({ engine: "local", model: "whisper-large-v3-turbo", on: "computers" });
    // a project in English and only the Mac's Parakeet chosen: there it runs
    writeVoicePrefs("ana", { stt: { per: { transcripts: { engine: "local", model: "parakeet-tdt-0.6b-v3" } } } });
    expect(speechFor("ana", "transcripts", ["en"])).toMatchObject({ model: "parakeet-tdt-0.6b-v3", on: "computers" });
    // a model no computer has says which one is needed
    writeVoicePrefs("ana", { stt: { per: { transcripts: { engine: "local", model: "whisper-large-v3" } } } });
    expect(speechFor("ana", "transcripts")).toEqual({ needs: "Needs Whisper large-v3 on one of your computers" });
    // the server's own model is not on this server (no CT_LOCAL)
    writeVoicePrefs("ana", { stt: { per: { transcripts: { engine: "local", model: "whisper-base" } } } });
    expect(speechFor("ana", "transcripts")).toEqual({ needs: "Needs a speech model on one of your computers" });
  });

  // the AI Editor cuts at restarts and "um"s: on a computer only with Parakeet (EDITOR_COMPUTER_MODEL), only when picked,
  // only for an edit in English alone; anything else stays on Deepgram, as before
  it("the AI Editor: offered a computer with Parakeet, never on Automatic, Deepgram for another model or language", async () => {
    writeVoicePrefs("ana", { languages: ["en"], stt: { default: { engine: "auto" }, per: { transcripts: null } } });
    const v = (await (await app.request("/api/voice-prefs", { headers: { authorization: key } })).json()) as { available: string[]; availableFor: Record<string, string[]>; resolved: { use: string }[] };
    expect(v.availableFor.transcripts).toContain("local");
    expect(v.availableFor.captions).toContain("local");
    expect(v.availableFor.mic).toContain("local");
    expect(v.availableFor.editor).toContain("local");   // the Mac has Parakeet
    expect(v.available).not.toContain("local");
    // Automatic with no key: the others run on a computer, the AI Editor is never sent there unasked
    expect(speechFor("ana", "transcripts")).toMatchObject({ engine: "local", on: "computers" });
    expect(speechFor("ana", "captions")).toMatchObject({ engine: "local", on: "computers" });
    expect(speechFor("ana", "mic")).toMatchObject({ engine: "local", on: "computers" });
    expect(speechFor("ana", "editor")).toEqual({ needs: "Add your Deepgram (or OpenAI) key in Settings → API keys", key: "DEEPGRAM_API_KEY" });
    // picked, for an English edit: Parakeet on her computers, and the worker is told so (never a key)
    writeVoicePrefs("ana", { stt: { per: { editor: { engine: "local" } } } });
    expect(speechFor("ana", "editor")).toEqual({ engine: "local", model: "parakeet-tdt-0.6b-v3", on: "computers", languages: ["en"] });
    expect(speechJob("ana", "editor", ["en"])).toEqual({ engine: "local", model: "parakeet-tdt-0.6b-v3", languages: ["en"] });
    // an edit in another language, in two, or in none known: Deepgram, and the row says why
    saveMyKey("ana", "DEEPGRAM_API_KEY", "dg-ana");
    const english = "On your computers only edits in English: this runs on Deepgram";
    expect(speechFor("ana", "editor", ["et"])).toEqual({ engine: "deepgram", model: "nova-3", key: "dg-ana", languages: ["et"], note: english });
    expect(speechJob("ana", "editor", ["en", "et"])).toEqual({ engine: "deepgram", model: "nova-3", languages: ["en", "et"] });
    writeVoicePrefs("ana", { languages: [] });
    expect(resolvedOne("ana", "editor")).toEqual({ use: "editor", engine: "deepgram", model: "nova-3", note: english });
    // another model on computers: Deepgram too
    writeVoicePrefs("ana", { languages: ["en"], stt: { per: { editor: { engine: "local", model: "whisper-large-v3-turbo" } } } });
    expect(speechFor("ana", "editor")).toMatchObject({ engine: "deepgram", note: "On your computers only with Parakeet: this runs on Deepgram" });
    // the Default set to computers does not move the AI Editor: only its own row does
    writeVoicePrefs("ana", { stt: { default: { engine: "local" }, per: { editor: null } } });
    expect(speechFor("ana", "editor")).toMatchObject({ engine: "deepgram", note: "On your computers only when picked on this row: this runs on Deepgram" });
    // with a key, Automatic stays on Deepgram
    writeVoicePrefs("ana", { stt: { default: { engine: "auto" } } });
    expect(speechFor("ana", "editor")).toMatchObject({ engine: "deepgram", model: "nova-3" });
    saveMyKey("ana", "DEEPGRAM_API_KEY", null);
    // no Deepgram key and an edit Parakeet can't hear: the plain need
    writeVoicePrefs("ana", { stt: { per: { editor: { engine: "local" } } } });
    expect(speechFor("ana", "editor", ["et"])).toEqual({ needs: "Needs a Deepgram key", key: "DEEPGRAM_API_KEY" });
    writeVoicePrefs("ana", { languages: [], stt: { default: { engine: "auto" }, per: { editor: null, mic: null } } });
  });

  it("the AI Editor needs Parakeet itself: a computer with only Whisper is not offered for it", () => {
    const solo = pairDevice("eli", "Tiny Laptop");
    setDeviceKinds(solo.device.id, [TRANSCRIBE_KIND]);
    setDeviceStt(solo.device.id, { want: [], held: ["whisper-large-v3-turbo"], getting: [], claimed: true });
    writeVoicePrefs("eli", { languages: ["en"], stt: { per: { editor: { engine: "local" } } } });
    expect(availableEngines("eli", "editor")).not.toContain("local");
    expect(availableEngines("eli", "captions")).toContain("local");
    expect(speechFor("eli", "editor")).toEqual({ needs: "Needs Parakeet TDT 0.6B v3 on one of your computers" });
    expect(speechJob("eli", "editor")).toEqual({ languages: ["en"] });   // the worker stays on Deepgram
  });
});

describe("an edit's sound goes only to its owner's computers", () => {
  it("an edit by A never reaches B's computer, even when only B's has Parakeet on", async () => {
    createUser("abe", "password1");
    createUser("bea", "password1");
    const a = pairDevice("abe", "Abe's PC");
    const b = pairDevice("bea", "Bea's PC");
    await report(a.token, { os: "linux", cpus: 8, memGb: 16, freeGb: 20 });
    await report(b.token, { os: "linux", cpus: 64, memGb: 128, freeGb: 90, gpu: "RTX", gpuMemGb: 48 });
    for (const who of ["abe", "bea"]) writeVoicePrefs(who, { languages: ["en"], stt: { per: { editor: { engine: "local" } } } });
    const parakeet = ["parakeet-tdt-0.6b-v3"];
    // only B's computer has Parakeet: A's edit is not sent to any computer
    expect((await claim(b.token, parakeet)).job).toBeNull();
    expect(await editorWordsFromComputer("abe", ["en"], new Uint8Array([1, 2, 3]))).toEqual({ why: "Not set to run on your computers" });
    expect((await claim(b.token, parakeet)).job).toBeNull();
    // A's computer gets Parakeet too and stays quiet: A's window waits for it; B's stronger computer is never handed it
    await claim(a.token, parakeet);
    const words = editorWordsFromComputer("abe", ["en"], new TextEncoder().encode("RIFF-abe"));
    await vi.waitFor(() => expect(transcriptWaits(deviceOf(a.device.id)!, { on: true, weights: {} })).toBe(true));
    expect((await claim(b.token, parakeet)).job).toBeNull();
    const got = (await claim(a.token, parakeet)).job!;
    expect(got).toMatchObject({ kind: TRANSCRIBE_KIND, model: "parakeet-tdt-0.6b-v3", languages: ["en"] });
    // its sound only to A's computer, and only A's computer can answer it
    expect((await app.request(`/api/devices/relay/transcribe/${got.id}`, { headers: as(b.token) })).status).toBe(404);
    expect(await (await app.request(`/api/devices/relay/transcribe/${got.id}`, { headers: as(a.token) })).text()).toBe("RIFF-abe");
    const um = { words: [{ text: "Uh,", start: 0, end: 0.3 }, { text: "if", start: 0.4, end: 0.5 }], language: "en" };
    expect((await app.request(`/api/devices/relay/transcribe/${got.id}`, json(um, as(b.token)))).status).toBe(404);
    expect((await app.request(`/api/devices/relay/transcribe/${got.id}`, json(um, as(a.token)))).status).toBe(200);
    expect(await words).toEqual(um);   // no confidence: Parakeet has none
  });
});

describe("Download and Remove", () => {
  it("a press reaches the computer on its next claim; nothing is deleted that was not asked", async () => {
    expect((await want(pc.device.id, "whisper-base", true)).status).toBe(400);
    expect((await want("nobody", "whisper-large-v3", true)).status).toBe(400);
    expect((await want(pc.device.id, "whisper-large-v3", true)).status).toBe(200);
    expect((await voice()).computers[0]).toMatchObject({ name: "Tiny PC", models: [{ id: "whisper-large-v3-turbo", state: "ready" }, { id: "whisper-large-v3", state: "asked" }] });
    expect((await claim(pc.token, ["whisper-large-v3-turbo"])).models).toEqual(["whisper-large-v3-turbo", "whisper-large-v3"]);
    await claim(pc.token, ["whisper-large-v3-turbo"], ["whisper-large-v3"]);
    expect((await voice()).computers[0]!.models.find((m) => m.id === "whisper-large-v3")?.state).toBe("downloading");
    expect((await want(pc.device.id, "whisper-large-v3-turbo", false)).status).toBe(200);
    expect((await claim(pc.token, ["whisper-large-v3-turbo", "whisper-large-v3"])).models).toEqual(["whisper-large-v3"]);
    // the Mac's two models were never asked about: they stay
    expect((await claim(mac.token, ["whisper-large-v3-turbo", "parakeet-tdt-0.6b-v3"])).models).toEqual(["whisper-large-v3-turbo", "parakeet-tdt-0.6b-v3"]);
  });

  it("with large-v3 and turbo both downloaded and none chosen, turbo runs: it is the default", async () => {
    await claim(pc.token, ["whisper-large-v3", "whisper-large-v3-turbo"]);
    writeVoicePrefs("ana", { languages: [], stt: { default: { engine: "local" }, per: { transcripts: null } } });
    expect(speechFor("ana", "transcripts")).toMatchObject({ model: "whisper-large-v3-turbo", on: "computers" });
  });

  it("a Mac: offered only what it runs, and what its person did on it (Dictation) is the wish", async () => {
    const studio = pairDevice("ana", "Tiny Studio Mac");
    await report(studio.token, { os: "mac", cpus: 10, memGb: 16, freeGb: 8 });
    setDeviceKinds(studio.device.id, [TRANSCRIBE_KIND]);
    // a Mac runs Core ML models, a Linux helper the others
    expect((await want(studio.device.id, "whisper-large-v3", true)).status).toBe(400);
    expect((await want(pc.device.id, "whisper-small", true)).status).toBe(400);
    // Download pressed before its first claim, with turbo already on it from before: both stay
    expect((await want(studio.device.id, "whisper-small", true)).status).toBe(200);
    expect((await claim(studio.token, ["whisper-large-v3-turbo"])).models).toEqual(["whisper-small", "whisper-large-v3-turbo"]);
    expect((await claim(studio.token, ["whisper-large-v3-turbo", "whisper-small"])).models).toEqual(["whisper-small", "whisper-large-v3-turbo"]);
    // a model a person downloaded on the Mac itself is kept, not deleted on its next claim
    const got = await claim(studio.token, ["whisper-large-v3-turbo", "whisper-small", "whisper-base.en"], [], ["whisper-base.en"]);
    expect(got.models).toEqual(["whisper-small", "whisper-large-v3-turbo", "whisper-base.en"]);
    // one removed there is not downloaded again
    expect((await claim(studio.token, ["whisper-large-v3-turbo", "whisper-base.en"])).models).toEqual(["whisper-large-v3-turbo", "whisper-base.en"]);
    // the page offers it the Mac's models only
    const shown = (await voice()).computers.find((c) => c.name === "Tiny Studio Mac") as { os?: string } | undefined;
    expect(shown?.os).toBe("mac");
  });
});
