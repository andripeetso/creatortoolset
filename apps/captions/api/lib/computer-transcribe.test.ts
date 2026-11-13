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
const { pairDevice, touchDevice } = await import("./devices");
const { strongest, transcribeOnComputer, ComputerOff, COMPUTER_LIMITS } = await import("./computer-transcribe");
const { speechFor, writeVoicePrefs } = await import("./speech");

const ana = createUser("ana", "password1");
const key = `Bearer ${newApiKey(ana, "full")}`;
const json = (body: unknown, extra: Record<string, string> = {}, method = "POST") => ({ method, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const report = (token: string, machine: Record<string, unknown>) => app.request("/api/devices/relay/report", json({ drivers: [], homes: [], machine }, as(token)));
const claim = async (token: string, models: string[] = [], getting: string[] = []) =>
  (await (await app.request("/api/devices/relay/editor/claim", json({ kinds: [TRANSCRIBE_KIND], models, getting }, as(token)))).json()) as { job: { id: number; model: string } | null; models: string[] };
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
});
