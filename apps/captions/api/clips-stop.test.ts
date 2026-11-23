import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "clips-stop-"));
process.env.DATA_DIR = dataDir;
delete process.env.DEEPGRAM_API_KEY;
// on Cloud with no computer a note waits, processing, for one: the run Stop ends
process.env.CT_LOCAL = "1";
process.env.CT_SERVER = "cloud";
afterAll(() => {
  delete process.env.CT_LOCAL;
  delete process.env.CT_SERVER;
  rmSync(dataDir, { recursive: true, force: true });
});

// the words are never heard here: a call says the run went on to transcribe
const heard = vi.fn(async () => ({ error: "No key" }));
vi.mock("./transcribe", async (real) => ({ ...(await real<typeof import("./transcribe")>()), transcribeWav: heard }));

const { cancel, clipsApp, noteFiled, recordingPath, stopsHeld } = await import("./clips");
await import("./work/task-kinds");

const as = (username: string) => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("user", { username, role: "user", cloud: true, off: [] });
    await next();
  });
  return app.route("/api/clips", clipsApp);
};
const ana = as("ana");

describe("Video Notes Stop", () => {
  it("ends a note being made as Stopped and keeps its recording; another account gets 404", async () => {
    const { id } = (await (await ana.request("/api/clips?name=Walk&mime=audio/wav", { method: "POST", body: new Uint8Array(64) })).json()) as { id: string };
    await vi.waitFor(async () => expect(((await (await ana.request(`/api/clips/${id}`)).json()) as { status: string }).status).toBe("processing"));
    expect((await as("bo").request(`/api/clips/${id}/stop`, { method: "POST" })).status).toBe(404);
    expect(await (await ana.request(`/api/clips/${id}/stop`, { method: "POST" })).json()).toEqual({ ok: true });
    expect(await (await ana.request(`/api/clips/${id}`)).json()).toMatchObject({ status: "error", error: "Stopped" });
    expect(existsSync(recordingPath(id))).toBe(true);
    // nothing running: still ok
    expect((await ana.request(`/api/clips/${id}/stop`, { method: "POST" })).status).toBe(200);
  }, 30_000);

  // a note that waits for its computer, and the sound that computer sends back
  const waiting = async (name: string) => {
    const { id } = (await (await ana.request(`/api/clips?name=${name}&mime=audio/wav`, { method: "POST", body: new Uint8Array(64) })).json()) as { id: string };
    await vi.waitFor(async () => expect(((await (await ana.request(`/api/clips/${id}`)).json()) as { status: string }).status).toBe("processing"));
    const sound = path.join(dataDir, `${id}-sound.wav`);
    writeFileSync(sound, new Uint8Array(64));
    return { id, sound };
  };

  it("a Stop while the computer's sound is being kept holds: no words are heard and the sound goes", async () => {
    const { id, sound } = await waiting("Gap");
    heard.mockClear();
    const filing = noteFiled(id, { duration: 1, audio: true }, { sound });
    cancel(id); // the Stop lands while the sound is being kept
    await filing;
    await new Promise((r) => setTimeout(r, 100));
    expect(heard).not.toHaveBeenCalled();
    expect(existsSync(path.join(dataDir, "clips", id, "audio.wav"))).toBe(false);
  }, 30_000);

  it("lets go of a note's Stop when its run ends", async () => {
    const held = stopsHeld();
    const { id, sound } = await waiting("Ends");
    await noteFiled(id, { duration: 1, audio: true }, { sound });
    await vi.waitFor(async () => expect(((await (await ana.request(`/api/clips/${id}`)).json()) as { status: string }).status).toBe("error"));
    await vi.waitFor(() => expect(stopsHeld()).toBe(held));
  }, 30_000);
});
