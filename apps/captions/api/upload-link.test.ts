import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "upload-link-"));
process.env.APP_SECRET = "upload-link-test-secret";

const { startUpload, PART_SIZE } = await import("./lib/uploads");
const first = await import("./assistant-files");

const ID = "00000000-0000-4000-8000-0000000000a1";
const parts = path.join(process.env.DATA_DIR, "assistant", "files", "sol", ID, "parts");
await startUpload(parts, { total: 2 * PART_SIZE, partSize: PART_SIZE, name: "Clip.mov", mime: "video/quicktime", owner: "sol" });
const put = (app: typeof first.uploadLinkApp, token: string) =>
  app.request(`/${token}/1`, { method: "PUT", headers: { "content-length": String(PART_SIZE), "content-type": "application/octet-stream" }, body: Buffer.alloc(PART_SIZE, 1) });

it("a link made by one server process works on the next one (a restart or a swap)", async () => {
  const token = first.uploadLink("sol", ID);
  vi.resetModules();
  const next = await import("./assistant-files");
  expect(next).not.toBe(first);
  expect((await put(next.uploadLinkApp, token)).status).toBe(200);
});

it("a link this server didn't sign, or one past its hour, is refused", async () => {
  const token = first.uploadLink("sol", ID);
  const forged = `ctu_${Buffer.from(`ana/${ID}/${Date.now()}`).toString("base64url")}.${token.split(".")[1]}`;
  expect((await put(first.uploadLinkApp, forged)).status).toBe(404);
  const now = Date.now();
  const spy = vi.spyOn(Date, "now").mockReturnValue(now - 2 * 3600_000);
  const old = first.uploadLink("sol", ID);
  spy.mockRestore();
  const ago = new Date(now - 2 * 3600_000);
  utimesSync(parts, ago, ago);
  expect((await put(first.uploadLinkApp, old)).status).toBe(404);
});
