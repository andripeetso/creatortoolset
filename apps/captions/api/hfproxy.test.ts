import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hfApp, OWN_COPY } from "./hfproxy";
import { env } from "./lib/env";

const file = "/test-model/resolve/main/weights.bin";
const kept = path.join(tmpdir(), "caption-studio-hf-cache", "test-model");
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(kept, { recursive: true, force: true });
});

it("sends a model file on while it is still arriving, keeps a copy, and serves the copy next time", async () => {
  let finish!: () => void;
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      finish = () => (c.enqueue(new Uint8Array([4, 5])), c.close());
    },
  });
  const fetched = vi.fn(async (_url: string, init?: RequestInit) => new Response(init?.method === "HEAD" ? null : upstream, { headers: { "content-length": "5" } }));
  vi.stubGlobal("fetch", fetched);

  // a size probe first: answered from the upstream's headers, and it starts no download
  const probe = await hfApp.request("/api/hf" + file, { method: "HEAD" });
  expect(probe.headers.get("content-length")).toBe("5");
  expect(fetched).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: "HEAD" }));
  expect(existsSync(path.join(kept, "resolve/main/weights.bin"))).toBe(false);

  const res = await hfApp.request("/api/hf" + file);
  expect(res.headers.get("content-length")).toBe("5");
  const reader = res.body!.getReader();
  // the first bytes are here although the upstream has not finished: the browser's progress moves
  expect([...(await reader.read()).value!]).toEqual([1, 2, 3]);
  finish();
  expect([...(await reader.read()).value!]).toEqual([4, 5]);
  expect((await reader.read()).done).toBe(true);

  await vi.waitFor(() => expect(existsSync(path.join(kept, "resolve/main/weights.bin"))).toBe(true));
  const again = await hfApp.request("/api/hf" + file);
  expect([...new Uint8Array(await again.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  expect(fetched).toHaveBeenCalledTimes(2); // the probe and the one download
});

it("one copy: a file the server's model library keeps is served from there, and that library's own fetch keeps none here", async () => {
  const data = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "hfproxy-"));
  const was = env.dataDir;
  Object.assign(env, { dataDir: data });
  try {
    mkdirSync(path.join(data, "models", "test-model"), { recursive: true });
    writeFileSync(path.join(data, "models", "test-model", "weights.bin"), Uint8Array.from([7, 8]));
    const fetched = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-length": "3" } }));
    vi.stubGlobal("fetch", fetched);
    const served = await hfApp.request("/api/hf" + file);
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([7, 8]);
    expect(fetched).not.toHaveBeenCalled();

    const other = "/test-model/resolve/main/other.bin";
    const own = await hfApp.request("/api/hf" + other, { headers: { [OWN_COPY]: "1" } });
    expect([...new Uint8Array(await own.arrayBuffer())]).toEqual([1, 2, 3]);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(path.join(kept, "resolve/main/other.bin"))).toBe(false);
  } finally {
    Object.assign(env, { dataDir: was });
    rmSync(data, { recursive: true, force: true });
  }
});
