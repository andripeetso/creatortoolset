import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import type { EditingStyle, FinishedEdit } from "../../contracts/editor-styles";

// Send to Finals finishes an edit as an approval does (finished.ts). Review sends only a ready video of 1080p or more,
// so this one test makes a real clip; the rest of the finished edits' tests are in finished.test.ts.

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-finished-finals-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-finished-finals-secret";
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { addVersion, readMeta, reviewJobsDone } = await import("../review");
const { saveDraft, saveStep } = await import("./store");

const cookies: Record<string, string> = {};
async function account(username: string, role: "user" | "admin" = "user") {
  setOff(createUser(username, "password1", { role }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const finished = (styleId: string) => json<FinishedEdit[]>(call("maker", "GET", `/api/editor/styles/${styleId}/finished`));

const timeline: Timeline = {
  name: "v1",
  fps: 25,
  width: 1080,
  height: 1920,
  sources: {},
  tracks: { V1: { name: "Speaker", items: [{ src: "ver_a", in: 0, len: 750, rec: 0 }] }, V2: { name: "B-roll", items: [] }, A1: { name: "Voice", items: [] }, A2: { name: "Music", items: [] }, A3: { name: "SFX", items: [] } },
  markers: [],
};

describe.skipIf(rootReplaced || !hasFfmpeg)("Finished edits: Send to Finals", () => {
  it("the maker sends an edit's preview to Finals: the edit is kept for its style; an admin who sends it keeps nothing", async () => {
    await account("maker");
    await account("boss", "admin");
    libraryDb().exec(`
      INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0);
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'maker', 0);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_a', 'ast_a', 1, 'k1', 1, 'x1', 'ready', 'maker', 0);
    `);
    const s = await json<EditingStyle>(call("maker", "POST", "/api/editor/styles", { name: "Sent to Finals" }));
    const { id } = await json<{ id: string }>(call("maker", "POST", "/api/editor", { name: "Tiny Acrobatics hook", sources: ["ver_a"], style: s.id, brief: "A reel about the class." }));
    await saveStep(id, "analysis", { sentences: [{ n: 1, src: "ver_a", text: "The class is on Monday.", s: 0, e: 1, w0: 0, w1: 4 }], notes: [] });
    const take = { first: 1, last: 1, score: 1 };
    await saveStep(id, "plan", { lines: [{ id: "L1", text: "AI-WROTE the class line", takes: [take] }], plans: [{ name: "v1", title: "AI-TITLE", lines: [{ line: "L1", take }] }], notes: [] });
    await saveDraft(id, "v1", { timeline, notes: [] });

    // the preview, as the preview step files it: a real 1080 x 1920 clip, so Review can send it
    const clip = path.join(dir, "preview.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=25:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]);
    expect(existsSync(clip)).toBe(true);
    const added = await addVersion(undefined, { owner: "maker", name: "Tiny Acrobatics hook v1.mp4", mime: "video/mp4", bytes: statSync(clip).size }, async (dest) => copyFileSync(clip, dest));
    const asset = added!.meta.id;
    await saveStep(id, "review", { v1: { assetId: asset, n: 1 } });
    await reviewJobsDone();
    for (let i = 0; i < 200 && !(await readMeta(asset))?.versions[0]?.versionId; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await readMeta(asset))!.versions[0]).toMatchObject({ status: "ready", width: 1080, height: 1920 });

    const send = (user: string) => call(user, "POST", `/api/review/assets/${asset}/v/1/finals`);
    const boss = await send("boss");
    expect(boss.status).toBe(200);
    expect(await finished(s.id)).toEqual([]);

    const mine = await send("maker");
    expect(mine.status).toBe(200);
    expect((await json(mine)).pieceId).toEqual(expect.any(String));
    expect(await finished(s.id)).toEqual([
      { editId: id, variant: "v1", name: "Tiny Acrobatics hook", at: expect.any(Number), brief: "A reel about the class.", targetS: 0, seconds: 30, said: "The class is on Monday.", cut: [] },
    ]);
  });
});
