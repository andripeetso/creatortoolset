import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";

// Designs, carousel styles, Video Notes and documents: each workspace lists its own; one from before workspaces is the first brand's.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ws-designer-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "ws-designer-test-secret";
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const { Hono } = await import("hono");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { designsApp } = await import("./designs");
const { clipsApp } = await import("./clips");
const { documentsApp } = await import("./documents");
const { createUser } = await import("./users");

createUser("ana", "password1", { role: "user" });
const at = (...p: string[]) => path.join(dataDir, ...p);
const file = (f: string, v: unknown) => (mkdirSync(path.dirname(f), { recursive: true }), writeFileSync(f, JSON.stringify(v)));
// "first" is the oldest brand: what was made before workspaces belongs to it
file(at("workshop", "projects", "first.json"), { id: "first", owner: "ana", name: "First", createdAt: 1, updatedAt: 1 });
file(at("workshop", "projects", "second.json"), { id: "second", owner: "ana", name: "Second", createdAt: 2, updatedAt: 2 });
file(at("workshop", "users", "ana.json"), { currentProjectId: "first" });

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => (c.set("user", { username: "ana", role: "user", cloud: true, off: [] }), next()));
app.use("*", inRequestWorkspace);
app.route("/api/designs", designsApp as never);
app.route("/api/clips", clipsApp as never);
app.route("/api/documents", documentsApp as never);
const call = async (url: string, ws: string, body?: unknown) =>
  (await app.request(url, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-ct-workspace": ws }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const names = async (url: string, ws: string, pick: (r: never) => { name: string }[] = (r) => r) => pick((await call(url, ws)) as never).map((x) => x.name).sort();

it("a design and a carousel style made in one workspace are listed only there", async () => {
  await call("/api/designs", "second", { format: "portrait", blank: true, name: "Second's design" });
  await call("/api/designs", "first", { format: "portrait", blank: true, name: "First's design" });
  await call("/api/designs/styles", "second", { name: "Second's look" });
  // a style from before workspaces: no projectId
  const { createAnimation } = await import("./editor/animation-styles");
  createAnimation("ana", { name: "Old look" }, "carousel");
  expect(await names("/api/designs", "second")).toEqual(["Second's design"]);
  expect(await names("/api/designs", "first")).toEqual(["First's design"]);
  const styles = (r: { styles: { name: string }[] }) => r.styles;
  expect(await names("/api/designs/styles", "second", styles as never)).toEqual(["Second's look"]);
  expect(await names("/api/designs/styles", "first", styles as never)).toEqual(["Old look"]);
});

it("Video Notes and documents are listed in their own workspace; old ones in the first brand", async () => {
  const note = (id: string, name: string, projectId?: string) =>
    file(at("clips", id, "meta.json"), { id, name, owner: "ana", ...(projectId ? { projectId } : {}), duration: 1, bytes: 1, mime: "video/mp4", status: "ready", progress: 1, createdAt: 1, updatedAt: 1 });
  note("note-second", "Second's note", "second");
  note("note-old", "Old note");
  const doc = (id: string, name: string, projectId?: string) =>
    file(at("documents", id, "meta.json"), { id, name, owner: "ana", ...(projectId ? { projectId } : {}), prompt: "", sources: [], published: false, status: "ready", createdAt: 1, updatedAt: 1 });
  doc("doc-second", "Second's guide", "second");
  doc("doc-old", "Old guide");
  expect(await names("/api/clips", "second")).toEqual(["Second's note"]);
  expect(await names("/api/clips", "first")).toEqual(["Old note"]);
  expect(await names("/api/documents", "second")).toEqual(["Second's guide"]);
  expect(await names("/api/documents", "first")).toEqual(["Old guide"]);
  // the notes a document is written from follow the same workspace
  expect(await names("/api/documents/media", "second", ((r: { clips: { name: string }[] }) => r.clips) as never)).toEqual(["Second's note"]);
  // one uploaded from a window is saved with that window's workspace (not a real recording: its processing fails)
  const r = await app.request("/api/clips?name=Uploaded&mime=video/mp4", { method: "POST", headers: { "x-ct-workspace": "second" }, body: "not a video" });
  const made = (await r.json()) as { id: string; projectId?: string };
  expect(made.projectId).toBe("second");
  expect(await names("/api/clips", "second")).toEqual(["Second's note", "Uploaded"]);
  expect(await names("/api/clips", "first")).toEqual(["Old note"]);
  await vi.waitFor(async () => expect(((await call(`/api/clips/${made.id}`, "second")) as { status: string }).status).not.toBe("processing"), { timeout: 20_000 });
  // by its id a note in another workspace still opens
  expect(((await call("/api/clips/note-second", "first")) as { name: string }).name).toBe("Second's note");
});
