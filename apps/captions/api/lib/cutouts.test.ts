import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CUTOUT_KIND } from "../../contracts/devices";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "cutouts-"));
process.env.APP_SECRET = "cutouts-secret";

// the server with no plug-in: the cut-out plug-in off
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { deviceOf, pairDevice } = await import("./devices");
const { pictureType } = await import("./cutouts");

const ana = createUser("ana", "password1");
const key = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const as = { authorization: `Bearer ${mac.token}` };

describe("cut-outs with the plug-in off", () => {
  it("a Mac that lists the kind is never told of one and never handed one, and the AI has no such tool", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let status: number | undefined;
    try {
      void Promise.resolve(app.request("/api/devices/relay/wait", json({ blobs: true, editor: ["cards-draw", CUTOUT_KIND] }, as))).then((r) => (status = r.status));
      for (let i = 0; i < 40 && status === undefined; i++) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(1000);
      }
    } finally {
      vi.useRealTimers();
    }
    // held as long as it always was, and ended empty
    expect(status).toBe(204);
    expect(deviceOf(mac.device.id)?.kinds).toEqual(["cards-draw", CUTOUT_KIND]);
    expect(await (await app.request("/api/devices/relay/editor/claim", json({ kinds: [CUTOUT_KIND] }, as))).json()).toEqual({ job: null });
    expect((await app.request("/api/devices/relay/cutout/1", { headers: as })).status).toBe(404);
    const tools = ((await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: key }))).json()) as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name)).not.toContain("picture_cutout");
    expect((await app.request("/api/x/cutout", json({ data: "iVBORw0KGgo=" }, { authorization: key }))).status).toBe(404);
  });

  it("knows a PNG, a JPEG and a HEIC by their first bytes, and nothing else", () => {
    const of = (...parts: Array<string | number[]>) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
    expect(pictureType(of([0x89], "PNG\r\n\x1a\n", "rest"))).toBe("image/png");
    expect(pictureType(of([0xff, 0xd8, 0xff, 0xe1]))).toBe("image/jpeg");
    for (const brand of ["heic", "heix", "mif1"]) expect(pictureType(of([0, 0, 0, 24], `ftyp${brand}`))).toBe("image/heic");
    for (const other of [of("GIF89a"), of("RIFF\0\0\0\0WEBP"), of([0, 0, 0, 24], "ftypavif"), of([0, 0, 0, 24], "ftypisom"), of("Tiny"), Buffer.alloc(0)])
      expect(pictureType(other)).toBeNull();
  });
});
