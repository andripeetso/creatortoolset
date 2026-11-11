import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// A body a route streams by itself must reach it whole on a listening server. `app.request` hands a route its body in
// one piece, so only a real socket shows a stall: the body cap once asked the request for its body, which started the
// node request flowing into a web stream nobody read, and every route outside the cap's exempt list stopped answering
// after the first socket read (about 64 KB): an upload part of a video sent to the assistant, a Review reference.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "streamed-body-"));
delete process.env.APP_SECRET; // no sign-in: every request is the local admin

const { serve } = await import("@hono/node-server");
const app = (await import("./boot")).default;

const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => void server.close());

describe("a streamed body on a listening server", () => {
  it("takes an upload part of several socket reads on a route the body cap covers", async () => {
    const size = 400_000;
    const started = await fetch(`${base}/api/assistant/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Phone clip.mp4", mime: "video/mp4", size }),
    });
    const { id, partSize } = (await started.json()) as { id: string; partSize: number };
    const part = await fetch(`${base}/api/assistant/files/${id}/parts/1`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "upload-length": String(size), "upload-part-size": String(partSize), "content-type": "application/octet-stream" },
      body: new Uint8Array(size).fill(7),
    });
    expect(part.status).toBe(200);
    expect(await part.json()).toMatchObject({ ok: true, partNumber: 1, size });
  });

  it("still refuses a body over the cap from its declared length", async () => {
    const res = await fetch(`${base}/api/assistant/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(50 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });
});
