import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it, vi } from "vitest";

// Stop on captions the server makes by itself (a video sent from the chat): the chat's card ends as stopped, the project
// stays, and the sound that comes in late writes no captions.
const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "captions-stop-"));
process.env.DATA_DIR = root;
delete process.env.APP_SECRET;
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ends: { id: string; status: string }[] = [];
vi.mock("./assistant", () => ({ checkWork: () => {}, workEnded: (_u: string, id: string, e: { status: string }) => (ends.push({ id, status: e.status }), true) }));
// its editing copy is still being made when Stop is pressed
vi.mock("./projects", async (real) => ({ ...(await real<typeof import("./projects")>()), clipReadyToEdit: () => new Promise(() => {}) }));
vi.mock("./transcribe", async (real) => ({
  ...(await real<typeof import("./transcribe")>()),
  transcribeApp: new Hono().post("/", (c) => c.json({ words: [{ text: "flip", start: 0.2, end: 0.5 }] })),
}));
const { captionInBackground, captionsHeard, captioningWork } = await import("./captions-job");
const { projectsApp, captioning } = await import("./projects");
const { LOCAL_USER } = await import("./users");

const project = "11111111-1111-4111-8111-111111111111";
const clip = "22222222-2222-4222-8222-222222222222";
const dir = path.join(root, "projects", project);
mkdirSync(path.join(dir, "clips", clip), { recursive: true });
writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: project, name: "Tiny Acrobatics", owner: "local", createdAt: 1, updatedAt: 1, duration: 3, revision: 1, clips: [{ id: clip, name: "cut", duration: 3, createdAt: 1 }] }));
writeFileSync(path.join(dir, "data.json"), "{}");
writeFileSync(path.join(dir, "clips", clip, "data.json"), "{}");

const app = new Hono();
app.use(async (c, next) => {
  c.set("user" as never, LOCAL_USER as never);
  await next();
});
app.route("/api/projects", projectsApp);

it("Stop ends the job as stopped, and its late sound saves nothing", async () => {
  captionInBackground(LOCAL_USER, project, clip, "Tiny Acrobatics", "cloud");
  expect((await captioningWork(LOCAL_USER)).map((j) => j.id)).toEqual([project]);
  const r = await app.request(`/api/projects/${project}/captioning/stop`, { method: "POST" });
  expect(r.status).toBe(200);
  await new Promise((res) => setTimeout(res, 20)); // the chat is told once assistant.ts is loaded
  expect(ends).toEqual([{ id: `captions:${project}`, status: "stopped" }]);
  expect(captioning.has(project)).toBe(false);
  expect(await captioningWork(LOCAL_USER)).toEqual([]);
  const wav = path.join(root, "audio.wav");
  writeFileSync(wav, "RIFF");
  await captionsHeard("local", { project, clip, cloud: true, seconds: 3, name: "Tiny Acrobatics" }, { peaks: [], seconds: 3 }, { "audio.wav": wav });
  expect(JSON.parse(readFileSync(path.join(dir, "clips", clip, "data.json"), "utf8"))).toEqual({});
  // the late sound leaves the project free for Transcribe, exports and the Editor's captions
  expect(captioning.has(project)).toBe(false);
  await new Promise((res) => setTimeout(res, 20));
  expect(ends).toHaveLength(1);
  expect((await app.request("/api/projects/33333333-3333-4333-8333-333333333333/captioning/stop", { method: "POST" })).status).toBe(404);
});
