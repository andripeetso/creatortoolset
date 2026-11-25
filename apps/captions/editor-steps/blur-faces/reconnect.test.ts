// Blurred copies made before Face Blur, added to their clips (reconnect.ts): linked as the blurred version, a file that is
// its own blurred version, one kept as filmed, a dry run, a copy indexed before, and the undo.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? process.env.TMPDIR ?? tmpdir(), "blur-faces-reconnect-"));
process.env.LIBRARY_DISK_RESERVE_GB = "0";
delete process.env.APP_SECRET;

const { Hono } = await import("hono");
const { fileBlur, libraryDb, playOf } = await import("../../api/library/db");
const { saveToLibrary } = await import("../../api/library/routes");
const { default: plugin, autoJobs, queueVersion } = await import("./plugin");

const dir = process.env.DATA_DIR;
const app = new Hono<{ Variables: { user: unknown } }>();
app.use(async (c, next) => {
  c.set("user", { username: "ana", role: "user", off: [] });
  await next();
});
app.route("/api/x/blur-faces", plugin.routes!);
const call = async (method: string, url: string, body?: unknown) =>
  (await app.request(`/api/x/blur-faces${url}`, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })).json() as Promise<{
    rows: { result: string; copyVersionId?: string; error?: string }[];
    undone?: number;
  }>;
const reconnect = (rows: unknown[], dry = false) => call("POST", "/reconnect", { libraryId: "lib_a", dry, rows });

let n = 0;
/** A clip on Ana's Mac with Blur faces never asked (indexed before it was on); its version id and path there. */
async function original(): Promise<{ v: string; at: string }> {
  const file = path.join(dir, `in-${++n}.mp4`);
  writeFileSync(file, Buffer.from(`\0\0\0\x18ftypmp42${n}`, "latin1"));
  const r = await saveToLibrary("ana", file, `Tiny take ${n}.mp4`, [], "lib_a", true);
  if (!r || !("versionId" in r)) throw new Error("not added");
  const at = `/Volumes/Tiny/Media Library/take-${n}.mp4`;
  libraryDb().prepare("UPDATE asset_versions SET mac_path = ?, mac_device = 'mac-1' WHERE id = ?").run(at, r.versionId);
  return { v: r.versionId, at };
}
const sha = (c: string) => c.repeat(64);
const copy = (c: string) => ({ path: `/Volumes/Tiny/Footage/.old/blurred-${c}.mp4`, size: 1000 + n, quick: `quick-${c}-${n}`, sha256: sha(c) });
const answerOf = (v: string) => (libraryDb().prepare("SELECT a.blur FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(v) as { blur: string | null }).blur;

beforeAll(async () => {
  (await import("../../api/users")).createUser("ana", "secret-ana-acrobatics");
  libraryDb().prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_a', 'ana', 'A', 'local', '{"upload":"all"}', 0)`).run();
});

describe("blurred copies made before", () => {
  it("a dry run changes nothing", async () => {
    const { v, at } = await original();
    const r = await reconnect([{ path: at, action: "link", originalSha256: sha("1"), copy: copy("2") }], true);
    expect(r.rows[0]!.result).toBe("linked");
    expect(fileBlur(v)?.blurredVersionId).toBeNull();
    expect(answerOf(v)).toBeNull();
  });

  it("links the copy as the clip's blurred version, played in its place, and queues nothing for Face Blur", async () => {
    const { v, at } = await original();
    const c = copy("3");
    const r = await reconnect([{ path: at, action: "link", originalSha256: sha("4"), copy: c }]);
    expect(r.rows[0]).toMatchObject({ result: "linked" });
    const blurred = fileBlur(v)?.blurredVersionId;
    expect(blurred).toBe(r.rows[0]!.copyVersionId);
    expect(playOf(v)).toBe(blurred);
    expect(answerOf(v)).toBe("yes");
    expect((libraryDb().prepare("SELECT mac_path FROM asset_versions WHERE id = ?").get(blurred!) as { mac_path: string }).mac_path).toBe(c.path);
    expect(await queueVersion({ libraryId: "lib_a", versionId: v, owner: "ana" })).toBe(false);
    expect(autoJobs.claim({ id: "mac-1", owner: "ana" })).toBeNull();
    // again: done before, nothing added twice
    expect((await reconnect([{ path: at, action: "link", originalSha256: sha("4"), copy: c }])).rows[0]!.result).toBe("done before");
  });

  it("marks an already blurred file as its own blurred version, and keeps another as filmed", async () => {
    const a = await original();
    const b = await original();
    const r = await reconnect([
      { path: a.at, action: "self", originalSha256: sha("5") },
      { versionId: b.v, action: "filmed" },
    ]);
    expect(r.rows.map((x) => x.result)).toEqual(["blurred", "filmed"]);
    expect(fileBlur(a.v)).toEqual({ blur: "yes", blurredVersionId: a.v });
    expect(playOf(a.v)).toBe(a.v);
    expect(await queueVersion({ libraryId: "lib_a", versionId: a.v, owner: "ana" })).toBe(false);
    expect(answerOf(b.v)).toBe("no");
  });

  it("reports a copy that is already a clip of its own, and adds nothing", async () => {
    const indexed = await original();
    libraryDb().prepare("UPDATE asset_versions SET full_sha256 = ? WHERE id = ?").run(sha("6"), indexed.v);
    const { v, at } = await original();
    const r = await reconnect([{ path: at, action: "link", originalSha256: sha("7"), copy: copy("6") }]);
    expect(r.rows[0]!.result).toBe("merge-needed");
    expect(fileBlur(v)?.blurredVersionId).toBeNull();
  });

  it("refuses a file whose size or SHA-256 differs, and one not in the library", async () => {
    const { v, at } = await original();
    libraryDb().prepare("UPDATE asset_versions SET full_sha256 = ? WHERE id = ?").run(sha("8"), v);
    const r = await reconnect([
      { path: at, action: "self", originalSha256: sha("9") },
      { path: at, size: 1, action: "filmed" },
      { path: "/Volumes/Tiny/nowhere.mp4", action: "filmed" },
    ]);
    expect(r.rows.map((x) => x.result)).toEqual(["error", "error", "error"]);
  });

  it("refuses a \"blurred\" copy that is byte for byte its original, so its faces are never marked covered", async () => {
    const { at } = await original();
    const r = await reconnect([{ path: at, action: "link", originalSha256: sha("c"), copy: copy("c") }]);
    expect(r.rows[0]).toMatchObject({ result: "error", error: "The copy is the original, not blurred" });
  });

  it("undo puts every clip back as it was", async () => {
    const link = await original();
    const self = await original();
    const filmed = await original();
    const before = libraryDb().prepare("SELECT current_version_id AS c FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(link.v) as { c: string };
    const r = await reconnect([
      { path: link.at, action: "link", originalSha256: sha("a"), copy: copy("b") },
      { path: self.at, action: "self", originalSha256: sha("c") },
      { path: filmed.at, action: "filmed" },
    ]);
    const added = r.rows[0]!.copyVersionId!;
    expect((await call("DELETE", "/reconnect?libraryId=lib_a")).undone).toBeGreaterThanOrEqual(3);
    expect(libraryDb().prepare("SELECT 1 FROM asset_versions WHERE id = ?").get(added)).toBeUndefined();
    expect((libraryDb().prepare("SELECT current_version_id AS c FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(link.v) as { c: string }).c).toBe(before.c);
    for (const x of [link, self, filmed]) expect(answerOf(x.v)).toBeNull();
    expect(fileBlur(self.v)?.blurredVersionId).toBeNull();
    expect((libraryDb().prepare("SELECT full_sha256 FROM asset_versions WHERE id = ?").get(link.v) as { full_sha256: string | null }).full_sha256).toBeNull();
  });
});
