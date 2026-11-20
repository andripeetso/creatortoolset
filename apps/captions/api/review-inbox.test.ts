import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

// The Review bell shows the workspace the person is in (owner, 2026-11-16: "It should be the current workspace"), its
// unread count too; a note from before notes named a workspace goes by its video's.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "review-inbox-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const A = "bbbbbbbb-0000-4000-8000-000000000001"; // the first brand
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const put = (file: string, data: unknown) => (mkdirSync(path.dirname(file), { recursive: true }), writeFileSync(file, JSON.stringify(data)));
for (const [id, createdAt] of [[A, 1], [B, 2]] as const)
  put(path.join(dataDir, "workshop", "projects", `${id}.json`), { id, owner: "alex", name: id, audience: "", voice: "", cta: "", notes: "", createdAt, updatedAt: createdAt });
const OLD_VIDEO = "aaaaaaaa-0000-4000-8000-000000000001"; // B's, from before notes named a workspace
put(path.join(dataDir, "review", OLD_VIDEO, "meta.json"), { id: OLD_VIDEO, owner: "alex", name: "Old cut", versions: [], approval: { status: "none" }, createdAt: 1, updatedAt: 1, workspace: B });
const note = (id: string, assetId: string, workspace?: string) => ({ id, kind: "comment", by: "Ada", assetId, name: id, href: "/", at: 1, ...(workspace ? { workspace } : {}) });
put(path.join(dataDir, "review", "notifications", "alex.json"), [
  note("in-a", "aaaaaaaa-0000-4000-8000-00000000000a", A),
  note("in-b", "aaaaaaaa-0000-4000-8000-00000000000b", B),
  note("old-b", OLD_VIDEO),
  note("old-unknown", "cccccccc-0000-4000-8000-000000000001"), // its record is gone: the first brand's
]);

const { reviewApp, notifyWorkshopOwner } = await import("./review");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "user", cloud: false, off: [] } as never);
  await next();
});
app.use("*", inRequestWorkspace);
app.route("/", reviewApp);

const inbox = async (ws: string) => (await (await app.request("/notifications", { headers: { "x-ct-workspace": ws } })).json()) as { items: { id: string }[]; unread: number };
const ids = async (ws: string) => (await inbox(ws)).items.map((x) => x.id);

it("lists and counts only the current workspace's notes", async () => {
  expect(await ids(A)).toEqual(["in-a", "old-unknown"]);
  expect(await ids(B)).toEqual(["in-b", "old-b"]);
  expect((await inbox(A)).unread).toBe(2);

  // a new note names its workspace
  await notifyWorkshopOwner("alex", { kind: "workshop", by: "Content Workshop", name: "Reel", href: "/workshop", ref: "s1", workspace: B });
  const [fresh, ...rest] = await ids(B);
  expect(rest).toEqual(["in-b", "old-b"]);
  expect(await ids(A)).not.toContain(fresh);

  // Mark all read in B leaves A's unread
  await app.request("/notifications/read", { method: "POST", headers: { "content-type": "application/json", "x-ct-workspace": B }, body: "{}" });
  expect([(await inbox(B)).unread, (await inbox(A)).unread]).toEqual([0, 2]);
});

// 2026-11-20: the same cut or failure told again (filed twice, a sweep, a restart) is one note, and one phone push
it("tells the same filed cut and the same unread failure once, across a restart", async () => {
  const CUT = "aaaaaaaa-0000-4000-8000-0000000000c1";
  put(path.join(dataDir, "review", CUT, "meta.json"), { id: CUT, owner: "alex", name: "Cut", workspace: A, approval: { status: "needs_review" }, createdAt: 1, updatedAt: 1,
    versions: [{ n: 1, edit: { project: "p1", draft: "Reel_A_D1" } }] });
  const { onEvent } = await import("./lib/events");
  let pushes = 0;
  onEvent("waiting", () => void pushes++);
  const count = async (assetId: string) => ((await (await app.request("/notifications", { headers: { "x-ct-workspace": A } })).json()) as { items: { assetId: string }[] }).items
    .filter((x) => x.assetId === assetId).length;
  const { notifyReady } = await import("./review");
  await notifyReady(CUT, "AI Editor", "Draft 1 is ready to watch", { name: "Reel", key: "Reel_A_D1" });
  await notifyReady(CUT, "AI Editor", "Draft 1 is ready to watch", { name: "Reel", key: "Reel_A_D1" });
  const fail = { kind: "failed", by: "Editor", name: "Reel", text: "draft: no footage", href: "/editor/p1", ref: "p1", workspace: A } as const;
  await notifyWorkshopOwner("alex", fail);
  await notifyWorkshopOwner("alex", fail);
  // a restart: the module again, memory empty; the inbox on disk still knows
  vi.resetModules();
  (await import("./lib/events")).onEvent("waiting", () => void pushes++);
  const again = await import("./review");
  await again.notifyReady(CUT, "AI Editor", "Draft 1 is ready to watch", { name: "Reel", key: "Reel_A_D1" });
  await again.notifyWorkshopOwner("alex", fail);
  expect([await count(CUT), await count("p1"), pushes]).toEqual([1, 1, 1]);

  // read, then the same failure again: news again; the cut read and filed again is not
  await app.request("/notifications/read", { method: "POST", headers: { "content-type": "application/json", "x-ct-workspace": A }, body: "{}" });
  await notifyWorkshopOwner("alex", fail);
  await notifyReady(CUT, "AI Editor", "Draft 1 is ready to watch", { name: "Reel", key: "Reel_A_D1" });
  expect([await count(CUT), await count("p1")]).toEqual([1, 2]);

  // the next draft is news; the same failure unread but a day old is too
  await notifyReady(CUT, "AI Editor", "Draft 2 is ready to watch", { name: "Reel", key: "Reel_A_D2" });
  vi.useFakeTimers({ now: Date.now() + 25 * 3600_000, toFake: ["Date"] });
  await notifyWorkshopOwner("alex", fail);
  vi.useRealTimers();
  expect([await count(CUT), await count("p1")]).toEqual([2, 3]);
});
