import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { WorkFile } from "../../contracts/work";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-files-"));
process.env.DATA_DIR = path.join(dir, "data");

const { needsOriginal, quickPrint, resolveFiles } = await import("./files");
const { partPath, proxyPath } = await import("./cache");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const put = (p: string, b: Buffer) => (mkdirSync(path.dirname(p), { recursive: true }), writeFileSync(p, b), p);
const payload = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251));

/** A footage route over `data` that honours Range, and counts what it is asked. */
function server(data: Record<string, Buffer>) {
  return vi.fn(async (version: string, init: { headers: Record<string, string> }) => {
    const b = data[version];
    if (!b) return new Response("no", { status: 404 });
    const from = Number(/bytes=(\d+)-/.exec(init.headers.range ?? "")?.[1] ?? 0);
    return new Response(b.subarray(from), { status: from ? 206 : 200 });
  });
}

describe("resolveFiles", () => {
  it("takes a copy already here (index path, fingerprint under the folders, the cache) before downloading only what is left", async () => {
    const a = put(path.join(dir, "disk", "a.mov"), payload(10));
    const bBytes = payload(3 * (1 << 20) + 5, 3);
    const b = put(path.join(dir, "nas", "deep", "b.mov"), bBytes);
    put(proxyPath("vc"), payload(7));
    const d = payload(20, 9);
    const get = server({ vd: d });
    const files: WorkFile[] = [
      { id: "va", title: "a.mov", bytes: 10, path: a, proxy: { bytes: 4 } },
      { id: "vb", title: "b.mov", bytes: bBytes.length, path: path.join(dir, "old", "b.mov"), quick: (await quickPrint(b))!, proxy: { bytes: 4 } },
      { id: "vc", title: "c.mov", bytes: 999, proxy: { bytes: 7 } },
      { id: "vd", title: "d.mov", bytes: 999, proxy: { bytes: 20 } },
    ];
    const seen: number[] = [];
    const out = await resolveFiles({ files }, { folders: [path.join(dir, "nas")], get, signal: new AbortController().signal, progress: (p) => seen.push(p.done) });
    expect(out).toEqual({ va: a, vb: b, vc: proxyPath("vc"), vd: proxyPath("vd") });
    expect(get.mock.calls.map((c) => c[0])).toEqual(["vd"]);
    expect(readFileSync(proxyPath("vd"))).toEqual(d);
    expect(seen.at(-1)).toBe(20);
    // found again by where it was last found
    expect(JSON.parse(readFileSync(path.join(dir, "data", "found.json"), "utf8"))).toEqual({ vb: b });
  });

  it("never asks for an original: a step that needs one it doesn't have fails with one line, before any download", async () => {
    put(proxyPath("ve"), payload(5));
    const get = server({ vf: payload(9) });
    const files: WorkFile[] = [
      { id: "vf", title: "f.mov", bytes: 99, proxy: { bytes: 9 } },
      { id: "ve", title: "e.mov", bytes: 99, path: path.join(dir, "gone.mov"), proxy: { bytes: 5 }, original: true },
    ];
    await expect(resolveFiles({ files }, { folders: [], get, signal: new AbortController().signal })).rejects.toThrow(needsOriginal("e.mov"));
    expect(get).not.toHaveBeenCalled();
  });

  it("resumes a .part with Range", async () => {
    const full = payload(16, 5);
    put(partPath("vr"), full.subarray(0, 6));
    const get = server({ vr: full });
    const out = await resolveFiles({ files: [{ id: "vr", title: "r.mov", bytes: 99, proxy: { bytes: 16 } }] }, { folders: [], get, signal: new AbortController().signal });
    expect(get.mock.calls[0]![1].headers.range).toBe("bytes=6-");
    expect(readFileSync(out.vr!)).toEqual(full);
    expect(existsSync(partPath("vr"))).toBe(false);
  });

  it("Cancel stops a download at once and keeps the .part for the next try", async () => {
    const full = payload(12, 2);
    const ctl = new AbortController();
    // the server sends 4 bytes, then nothing more
    const get = vi.fn(async () => new Response(new ReadableStream({ start: (c) => c.enqueue(full.subarray(0, 4)) }), { status: 200 }));
    const file: WorkFile = { id: "vx", title: "x.mov", bytes: 99, proxy: { bytes: 12 } };
    const run = resolveFiles({ files: [file] }, { folders: [], get, signal: ctl.signal, progress: (p) => p.done >= 4 && ctl.abort() });
    await expect(run).rejects.toThrow();
    expect(readFileSync(partPath("vx"))).toEqual(full.subarray(0, 4));
    expect(existsSync(proxyPath("vx"))).toBe(false);
    const again = server({ vx: full });
    await resolveFiles({ files: [file] }, { folders: [], get: again, signal: new AbortController().signal });
    expect(again.mock.calls[0]![1].headers.range).toBe("bytes=4-");
    expect(readFileSync(proxyPath("vx"))).toEqual(full);
  });
});
