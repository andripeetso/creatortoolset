import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

// A clip in the trash stays there when a scan or the Mac finds its file again (same path, or the same fingerprint
// elsewhere): its place is kept, no new clip is made. Restore brings it back. And an AI Editor worker's Phone uploads
// folder inside a Media folder is never footage.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "trash-stays-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { createUser } = await import("../users");
const { libraryDb } = await import("./db");
const { applyReport, indexForDevice, librariesOf } = await import("./report");
const { indexOnMac } = await import("./on-mac");
const { setTrashedAt } = await import("./trash");
const { changeStorage } = await import("../devices-storage");
const { pairDevice } = await import("../lib/devices");
createUser("tia", "password1", { role: "admin" });

const d = libraryDb();
const DIR = "/Volumes/Tiny Footage/Shoots";
const mac = pairDevice("tia", "Tiny Mac").device;
await changeStorage("tia", (st) => {
  st.folders.push({ id: "fold_t", role: "footage", name: "Shoots", origin: { host: mac.id, path: DIR }, make: false, createdAt: 0, reach: {} });
});
const folder = { id: "fold_t", role: "footage", name: "Shoots", origin: { host: mac.id, path: DIR }, make: false, createdAt: 0, reach: {} } as Parameters<typeof librariesOf>[1];

const quick = (n: number) => n.toString(16).padStart(64, "0");
const file = (rel: string, q: number) => ({ path: `${DIR}/${rel}`, bytes: 10, mtime: 1_700_000_000_000, quick: quick(q) });
let n = 0;
const report = (files: ReturnType<typeof file>[]) => applyReport(mac, [{ id: "fold_t", state: "ok", scan: `s${++n}`, complete: true, files, unreadable: [] }]);
const onMac = (rel: string, q: number) => ({ name: path.basename(rel), path: `${DIR}/${rel}`, size: 10, quick: quick(q), frames: [] });
const assets = () => (d.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;

it("a file under Phone uploads/ in a Media folder is never indexed: not answered for indexing, refused when sent", async () => {
  const answer = await report([file("Phone uploads/Tiny Edit 1234abcd/01 clip.mov", 90), file("Day 1/a.mov", 91)]);
  expect(answer.index.map((i) => i.path)).toEqual([`${DIR}/Day 1/a.mov`]);
  expect(await indexForDevice(mac, "fold_t", onMac("Phone uploads/Tiny Edit 1234abcd/01 clip.mov", 90))).toBe("Inside Source media: not imported as footage");
  expect(assets()).toBe(0);
});

let assetId = "";
it("a trashed clip's file scanned again, at its path or elsewhere, keeps it in the trash and makes no new clip", async () => {
  const made = (await indexForDevice(mac, "fold_t", onMac("Day 2/b.mov", 2))) as { versions: { versionId?: string }[] };
  const versionId = made.versions[0]!.versionId!;
  assetId = (d.prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(versionId) as { asset_id: string }).asset_id;
  setTrashedAt(assetId, Date.now());
  const before = assets();

  expect((await report([file("Day 2/b.mov", 2)])).index).toEqual([]);
  expect((await report([file("Moved/b copy.mov", 2)])).index).toEqual([]);
  expect(assets()).toBe(before);
  const places = d.prepare("SELECT path, state FROM version_places WHERE version_id = ? AND state = 'verified'").all(versionId) as { path: string }[];
  expect(places.map((p) => p.path)).toEqual([`${DIR}/Moved/b copy.mov`]);
  expect((d.prepare("SELECT trashed_at FROM assets WHERE id = ?").get(assetId) as { trashed_at: number | null }).trashed_at).not.toBeNull();
});

it("the Mac's own index or drop of that file makes no new clip, and never names the trashed one", async () => {
  const before = assets();
  const [lib] = await librariesOf("tia", folder);
  expect(await indexOnMac(lib!.id, "tia", { ...onMac("Day 2/b.mov", 2), device: mac.id })).toEqual({ duplicate: true });
  expect(await indexOnMac(lib!.id, "tia", onMac("Elsewhere/b.mov", 2))).toEqual({ duplicate: true });
  expect(await indexForDevice(mac, "fold_t", onMac("Day 2/b.mov", 2))).toEqual({ versions: [{ library: lib!.id }] });
  expect(assets()).toBe(before);
});

it("restored, it is back, and a scan confirms its place as before", async () => {
  setTrashedAt(assetId, null);
  const [lib] = await librariesOf("tia", folder);
  expect(await indexOnMac(lib!.id, "tia", onMac("Day 2/b.mov", 2))).toEqual({ duplicateOf: assetId });
  expect((await report([file("Day 2/b.mov", 2)])).index).toEqual([]);
  const row = d.prepare("SELECT p.state FROM version_places p JOIN asset_versions v ON v.id = p.version_id WHERE v.asset_id = ? AND p.path = ?").get(assetId, `${DIR}/Day 2/b.mov`) as { state: string };
  expect(row.state).toBe("verified");
});
