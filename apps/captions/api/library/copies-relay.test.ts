// Copies between computers (copies.ts relayOpen, copyRelayIn): a version only another of the owner's computers holds
// streams from it through the server into the copy's computer, live, under every Upload setting; the server keeps no
// file and no copy_sends row. While that computer is offline the copy waits for it; a send cut short leaves nothing.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DeviceJob } from "../../contracts/devices";
import type { LibraryCopy } from "../../contracts/library";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-copies-relay-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
delete process.env.APP_SECRET;

const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { blobs, libraryDb } = await import("./db");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mac = pairDevice("local", "Tiny's Mac");
const laptop = pairDevice("local", "Tiny's laptop");
const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_r', 'local', 'R', 'local', ?, 0)").run('{"upload":"none"}');

const relay = (url: string, body: unknown, token = mac.token) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const claim = async (token = mac.token) => ((await (await relay("/api/devices/relay/editor/claim", { kinds: ["copy"] }, token)).json()) as { job: DeviceJob | null }).job;
const answer = (id: number, body: unknown, token = mac.token) => relay(`/api/devices/relay/job/copy/${id}`, body, token);
const copies = async () => ((await (await app.request("/api/library/lib_r/copies")).json()) as { copies: LibraryCopy[] }).copies;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tick = () => new Promise((r) => setTimeout(r, 20));
const get = (url: string, token = mac.token) => app.request(url, { headers: { authorization: `Bearer ${token}` } });
const post = (url: string, body: Buffer | ReadableStream<Uint8Array>, token = laptop.token) =>
  app.request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body, duplex: "half" } as RequestInit);

/** Every file under the server's data dir that holds `bytes` (the store, scratch, incoming). */
function filesHolding(bytes: Buffer, at = dir): string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(at, e.name);
    return e.isDirectory() ? filesHolding(bytes, p) : readFileSync(p).includes(bytes) ? [p] : [];
  });
}

let t = 1_000;
/** A clip whose version is only on the laptop's disk (indexed there: a quick hash only). */
function onLaptop(asset: string, body: Buffer) {
  const v = `vr-${asset}`;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_r', 'video', ?, 'local', ?)").run(asset, `R ${asset}`, t++);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at, mac_path, mac_device)
     VALUES (?, ?, 1, ?, ?, ?, 'video/quicktime', 'ready', 'local', ?, ?, ?)`,
  ).run(v, asset, `mac:${v}`, body.length, `mac:${v}`, t++, `/Users/tiny/${asset}.mov`, laptop.device.id);
  d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(v, asset);
  return v;
}

describe("copies between computers: a live relay, nothing stored", () => {
  it("starts the copy on the Mac", async () => {
    const add = await app.request("/api/library/lib_r/copies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: mac.device.id, path: "/Volumes/Tiny Copy" }) });
    expect(add.status).toBe(200);
    const check = (await claim())!;
    await answer(check.id, { gone: [] });
  });

  it("under Upload none streams a version only the laptop holds into the Mac's copy, and the server keeps no file of it", async () => {
    const body = Buffer.from("Tiny Acrobatics: only on the laptop ".repeat(2000));
    const v = onLaptop("ast-lap", body);
    expect(await claim(laptop.token)).toBeNull(); // the laptop's app polls the road: it is online, nothing for it yet
    const job = (await claim())!;
    expect(job.options).toMatchObject({ op: "copy", key: v, paths: "[]", size: String(body.length) });
    expect(job.options!.sha256).toBeUndefined(); // a quick hash only: the bytes relayed are the check
    const pull = get(job.options!.url!);
    await tick();
    const send = (await claim(laptop.token))!;
    expect(send.options).toMatchObject({ op: "send", key: v, size: String(body.length), paths: JSON.stringify(["/Users/tiny/ast-lap.mov"]) });
    expect(send.options!.url).toBe(`/api/devices/relay/job/copy/${send.id}/file`);
    expect((await post(send.options!.url!, body, mac.token)).status).toBe(404); // only the computer that holds the send
    const sent = post(send.options!.url!, body);
    const file = await pull;
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(body)).toBe(true);
    expect((await sent).status).toBe(200);
    // the copy's done is checked against the bytes that passed through
    expect((await answer(job.id, { done: { rel: job.options!.rel, size: body.length, sha256: "0".repeat(64) } })).status).toBe(409);
    expect((await answer(job.id, { done: { rel: job.options!.rel, size: body.length, sha256: sha(body) } })).status).toBe(200);
    expect(d.prepare("SELECT sha256 FROM copy_files WHERE version_id = ?").get(v)).toEqual({ sha256: sha(body) });
    expect(d.prepare("SELECT state FROM version_places WHERE version_id = ? AND device = ?").get(v, mac.device.id)).toEqual({ state: "verified" });
    expect(d.prepare("SELECT 1 FROM copy_sends").get()).toBeUndefined();
    expect(filesHolding(body.subarray(0, 64))).toEqual([]);
    expect((await copies())[0]!.pending).toBe(0);
  });

  it("waits for the laptop while it is offline, with its name, and asks nothing of anyone", async () => {
    onLaptop("ast-away", Buffer.from("Tiny Acrobatics away"));
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      expect(await claim()).toBeNull();
      expect((await copies())[0]).toMatchObject({ pending: 1, waitsFor: "Tiny's laptop" });
      expect((await copies())[0]!.needsUpload).toBeUndefined();
    } finally {
      later.mockRestore();
    }
    // back online: it streams
    await claim(laptop.token);
    const job = (await claim())!;
    expect(job.options!.key).toBe("vr-ast-away");
    await relay(`/api/devices/relay/job/copy/${job.id}/fail`, { error: "Stopped for the test" });
  });

  it("a send cut short ends the copy's pull with an error, leaves nothing on the server, and the file is tried again later", async () => {
    d.prepare("DELETE FROM asset_versions WHERE id = 'vr-ast-away'").run();
    const body = Buffer.from("Tiny Acrobatics cut short ".repeat(4000));
    const v = onLaptop("ast-cut", body);
    const job = (await claim())!;
    expect(job.options!.key).toBe(v);
    const pull = get(job.options!.url!);
    await tick();
    const send = (await claim(laptop.token))!;
    expect(send.options!.key).toBe(v);
    let n = 0;
    const half = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (n++ === 0) ctl.enqueue(body.subarray(0, body.length / 2));
        else ctl.error(new Error("the laptop went to sleep"));
      },
    });
    const sent = post(send.options!.url!, half);
    const file = await pull;
    await expect(file.arrayBuffer()).rejects.toThrow();
    expect((await sent).status).toBe(409);
    expect(filesHolding(body.subarray(0, 64))).toEqual([]);
    expect(d.prepare("SELECT 1 FROM copy_sends").get()).toBeUndefined();
    // the Mac's copy fails, so the file waits an hour and is tried again
    await relay(`/api/devices/relay/job/copy/${job.id}/fail`, { error: "The server did not send the file" });
    expect(d.prepare("SELECT copied_at FROM copy_files WHERE version_id = ?").get(v)).toEqual({ copied_at: null });
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_700_000);
    try {
      await claim(laptop.token); // the laptop is heard from at that time
      const again = (await claim())!;
      expect(again.options!.key).toBe(v);
      await relay(`/api/devices/relay/job/copy/${again.id}/fail`, { error: "Stopped for the test" });
    } finally {
      later.mockRestore();
    }
  });

  it("a version the server stores (a browser or phone upload) still copies from the store, with no send", async () => {
    d.prepare("DELETE FROM asset_versions WHERE id = 'vr-ast-cut'").run();
    const body = Buffer.from("Tiny Acrobatics from a phone");
    const key = "libraries/lib_r/v/vr-phone/source";
    const f = path.join(dir, "phone-upload");
    writeFileSync(f, body);
    await blobs.put(key, f);
    rmSync(f, { force: true });
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast-phone', 'lib_r', 'video', 'Phone', 'local', ?)").run(t++);
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES ('vr-phone', 'ast-phone', 1, ?, ?, ?, 'video/quicktime', 'ready', 'local', ?)`,
    ).run(key, body.length, sha(body), t++);
    const job = (await claim())!;
    expect(job.options).toMatchObject({ key: "vr-phone", sha256: sha(body) });
    const file = await get(job.options!.url!);
    expect(Buffer.from(await file.arrayBuffer()).equals(body)).toBe(true);
    expect(await claim(laptop.token)).toBeNull();
    expect((await answer(job.id, { done: { rel: job.options!.rel, size: body.length, sha256: sha(body) } })).status).toBe(200);
  });
});
