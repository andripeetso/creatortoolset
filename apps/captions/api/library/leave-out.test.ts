import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A Media folder's Folders left out (StorageFolder.leaveOut): files inside a folder of one of those names, at any depth,
// are never indexed, by a computer's scan, its index call, the Mac app's Look for new files, or this server's own watch.
// An empty list leaves out nothing more. Set by the account's own PUT /api/devices/storage/folders/:id/leave-out.
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "leave-out-")));
process.env.DATA_DIR = path.join(dir, "data");
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { createUser } = await import("../users");
const { applyReport, indexForDevice, leftOutOn } = await import("./report");
const { filesIn } = await import("./watch");
const { changeStorage, storageApp } = await import("../devices-storage");
const { pairDevice } = await import("../lib/devices");
const { inRequestWorkspace } = await import("../lib/workspace-scope");
const { notFootage } = await import("../../contracts/storage");
const { libraryDb } = await import("./db");
createUser("tia", "password1", { role: "admin" });
createUser("bo", "password1", { role: "admin" });

const mac = pairDevice("tia", "Tiny Mac").device;
const LEFT = "/Volumes/Tiny Footage/FOOTAGE";
const PLAIN = "/Volumes/Tiny Footage/Plain";
const row = (id: string, p: string, leaveOut?: string[]) => ({ id, role: "footage" as const, name: path.basename(p), origin: { host: mac.id, path: p }, make: false, createdAt: 0, reach: {}, ...(leaveOut ? { leaveOut } : {}) });
await changeStorage("tia", (st) => {
  st.folders.push(row("fold_left", LEFT, ["- NO SHARE", "- ORIGINAL ARCHIVE"]), row("fold_plain", PLAIN));
});

const quick = (n: number) => n.toString(16).padStart(64, "0");
let n = 0;
const report = (folder: string, root: string, rels: string[]) =>
  applyReport(mac, [{ id: folder, state: "ok", scan: `s${++n}`, complete: true, files: rels.map((rel, i) => ({ path: `${root}/${rel}`, bytes: 10, mtime: 1_700_000_000_000, quick: quick(n * 100 + i) })), unreadable: [] }]);
const onMac = (root: string, rel: string, q: number) => ({ name: path.basename(rel), path: `${root}/${rel}`, size: 10, quick: quick(q), frames: [] });

describe("a Media folder's Folders left out", () => {
  it("notFootage: a left-out name is matched as a whole folder name at any depth, never in the file name or a longer name", () => {
    const out = ["- NO SHARE"];
    expect(notFootage("- NO SHARE/x/clip.mov", undefined, out)).toBe(true);
    expect(notFootage("Day 1/deep/- NO SHARE/clip.mov", undefined, out)).toBe(true);
    expect(notFootage("- NO SHARE.mov", undefined, out)).toBe(false);
    expect(notFootage("- NO SHARE 2/clip.mov", undefined, out)).toBe(false);
    expect(notFootage("- NO SHARE/x/clip.mov")).toBe(false);
  });

  it("notFootage: a name matches in any case and in either Unicode form", () => {
    expect(notFootage("- no share/clip.mov", undefined, ["- NO SHARE"])).toBe(true);
    expect(notFootage("Day 1/- No Share/clip.mov", undefined, ["- no share"])).toBe(true);
    expect(notFootage("Cafe\u0301 shoot/clip.mov", undefined, ["Caf\u00e9 shoot"])).toBe(true);
    expect(notFootage("Caf\u00e9 shoot/clip.mov", undefined, ["Cafe\u0301 SHOOT"])).toBe(true);
  });

  it("a scan answers only the files outside them for indexing, and an index call for one inside is refused", async () => {
    const answer = await report("fold_left", LEFT, ["- NO SHARE/x/clip.mov", "Day 1/- ORIGINAL ARCHIVE/deep/b.mov", "Day 1/a.mov"]);
    expect(answer.index.map((i) => i.path)).toEqual([`${LEFT}/Day 1/a.mov`]);
    expect(await indexForDevice(mac, "fold_left", onMac(LEFT, "Day 1/- ORIGINAL ARCHIVE/deep/b.mov", 1))).toBe("Inside Source media: not imported as footage");
  });

  it("a folder with no list indexes everything as before", async () => {
    const answer = await report("fold_plain", PLAIN, ["- NO SHARE/x/clip.mov", "Day 1/a.mov"]);
    expect(answer.index.map((i) => i.path).sort()).toEqual([`${PLAIN}/- NO SHARE/x/clip.mov`, `${PLAIN}/Day 1/a.mov`]);
    const made = (await indexForDevice(mac, "fold_plain", onMac(PLAIN, "- NO SHARE/x/clip.mov", 2))) as { versions: { versionId?: string }[] };
    expect(made.versions[0]?.versionId).toBeTruthy();
  });

  it("the Mac app's Look for new files: a path inside a left-out folder of the caller's own Media folder is left out", async () => {
    expect(await leftOutOn("tia", `${LEFT}/a/- NO SHARE/c.mov`)).toBe(true);
    expect(await leftOutOn("tia", `${LEFT}/a/c.mov`)).toBe(false);
    expect(await leftOutOn("tia", `${PLAIN}/- NO SHARE/c.mov`)).toBe(false);
    expect(await leftOutOn("tia", `/Volumes/Elsewhere/- NO SHARE/c.mov`)).toBe(false);
    // the folder's path on another computer that found it counts too: no computer named is no way around the list
    await changeStorage("tia", (st) => {
      st.folders.find((f) => f.id === "fold_left")!.reach = { pc_2: { path: "/mnt/footage", at: 0 } };
    });
    expect(await leftOutOn("bo", `/mnt/footage/- NO SHARE/c.mov`)).toBe(false);
    expect(await leftOutOn("tia", `/mnt/footage/- NO SHARE/c.mov`)).toBe(true);
  });

  it("this server's own watch reads none of their files", async () => {
    const media = path.join(dir, "Shoots");
    mkdirSync(path.join(media, "Day 1", "- NO SHARE", "x"), { recursive: true });
    writeFileSync(path.join(media, "Day 1", "a.mp4"), "x");
    writeFileSync(path.join(media, "Day 1", "- NO SHARE", "x", "b.mp4"), "x");
    const row = { origin: { host: "this-computer", path: media }, reach: {}, leaveOut: ["- NO SHARE"] };
    expect((await filesIn(media, [], [row as never])).map((p) => path.relative(media, p))).toEqual([path.join("Day 1", "a.mp4")]);
    expect((await filesIn(media)).length).toBe(2);
  });
});

describe("a clip indexed before its folder was left out", () => {
  const ARCH = "/Volumes/Tiny Footage/Archive";
  const DAYS = "/Volumes/Tiny Footage/Days";
  const listOf = (id: string, leaveOut: string[]) =>
    changeStorage("tia", (st) => {
      st.folders.find((f) => f.id === id)!.leaveOut = leaveOut;
    });
  const trashed = (q: number) =>
    (libraryDb().prepare("SELECT a.trashed_at FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.quick = ?").get(quick(q)) as { trashed_at: number | null }).trashed_at !== null;
  const one = (folder: string, root: string, rel: string, q: number, scan = `t${++n}`, complete = true) =>
    applyReport(mac, [{ id: folder, state: "ok", scan, complete, files: [{ path: `${root}/${rel}`, bytes: 10, mtime: 1_700_000_000_000, quick: quick(q) }], unreadable: [] }]);
  const index = async (folder: string, root: string, rel: string, q: number) =>
    expect(((await indexForDevice(mac, folder, onMac(root, rel, q))) as { versions: { versionId?: string }[] }).versions[0]?.versionId).toBeTruthy();

  it("goes to the trash at the next scan, and stays there once the name is off the list", async () => {
    await changeStorage("tia", (st) => {
      st.folders.push(row("fold_arch", ARCH), row("fold_days", DAYS));
    });
    await index("fold_arch", ARCH, "- ORIGINAL ARCHIVE/x.mov", 500);
    await one("fold_arch", ARCH, "- ORIGINAL ARCHIVE/x.mov", 500);
    expect(trashed(500)).toBe(false);
    await listOf("fold_arch", ["- ORIGINAL ARCHIVE"]);
    await one("fold_arch", ARCH, "- ORIGINAL ARCHIVE/x.mov", 500);
    expect(trashed(500)).toBe(true);
    await listOf("fold_arch", []);
    expect((await one("fold_arch", ARCH, "- ORIGINAL ARCHIVE/x.mov", 500)).index).toEqual([]);
    expect(trashed(500)).toBe(true);
  });

  it("stays when a copy of it is found in another Media folder", async () => {
    await index("fold_days", DAYS, "Day 1/y.mov", 501);
    await one("fold_arch", ARCH, "- ORIGINAL ARCHIVE/y.mov", 501);
    await listOf("fold_arch", ["- ORIGINAL ARCHIVE"]);
    await one("fold_arch", ARCH, "- ORIGINAL ARCHIVE/y.mov", 501);
    expect(trashed(501)).toBe(false);
  });

  it("stays when a copy of it is in the same Media folder, on a later page of the same listing", async () => {
    await listOf("fold_arch", []);
    await index("fold_arch", ARCH, "- ORIGINAL ARCHIVE/z.mov", 502);
    await listOf("fold_arch", ["- ORIGINAL ARCHIVE"]);
    await one("fold_arch", ARCH, "- ORIGINAL ARCHIVE/z.mov", 502, "paged", false);
    await one("fold_arch", ARCH, "Day 9/z.mov", 502, "paged", true);
    expect(trashed(502)).toBe(false);
  });
});

describe("PUT /api/devices/storage/folders/:id/leave-out", () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(async (c, next) => {
    c.set("user", { username: c.req.header("x-as") ?? "tia", role: c.req.header("x-role") ?? "admin" } as never);
    return next();
  });
  app.use(inRequestWorkspace);
  app.route("/api/devices/storage", storageApp);
  const put = (id: string, leaveOut: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/devices/storage/folders/${id}/leave-out`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ leaveOut }) });
  const listed = async () => ((await (await app.request("/api/devices/storage?all=1")).json()) as { folders: { id: string; leaveOut?: string[] }[] }).folders.find((f) => f.id === "fold_plain");

  it("the account's own Media folder takes the list, trimmed and without repeats, and gives it back; [] clears it", async () => {
    const r = await put("fold_plain", [" - CLIP CATALOG ", "- CLIP CATALOG", "Tiny Archive"]);
    expect(r.status).toBe(200);
    expect((await listed())?.leaveOut).toEqual(["- CLIP CATALOG", "Tiny Archive"]);
    expect(await leftOutOn("tia", `${PLAIN}/Tiny Archive/c.mov`)).toBe(true);
    expect((await put("fold_plain", [])).status).toBe(200);
    expect((await listed())?.leaveOut).toBeUndefined();
  });

  it("refuses another account, a guest, a path or a list that is not names", async () => {
    expect((await put("fold_plain", ["x"], { "x-as": "bo" })).status).toBe(404);
    expect((await put("fold_plain", ["x"], { "x-role": "visitor" })).status).toBe(403);
    expect((await put("fold_plain", ["a/b"])).status).toBe(400);
    expect((await put("fold_plain", [".."])).status).toBe(400);
    expect((await put("fold_plain", "x")).status).toBe(400);
    expect((await listed())?.leaveOut).toBeUndefined();
  });
});
