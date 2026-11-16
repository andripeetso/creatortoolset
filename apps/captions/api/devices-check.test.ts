// Checking a second computer for helping with heavy work (lib/helper-check.ts): the page asks, the computer reports its
// disks again, then reads a file in each folder it reaches through the shared drive and times an encode; the result is
// kept on the computer and sets its load balancing weight.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DeviceJob, HelperCheck } from "../contracts/devices";
import type { AuthVars } from "./auth";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "devices-check-"));
const { devicesApp } = await import("./devices");
const { deviceOf, pairDevice, saveReport } = await import("./lib/devices");
const { storageFilePath } = await import("./lib/storage");
const { balanceFile } = await import("./lib/balance");

const USER = "owner-c";
const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: USER, role: "admin" } as never);
  return next();
});
app.route("/api/devices", devicesApp);

const studio = pairDevice(USER, "Tiny Studio Mac").device.id;
const helper = pairDevice(USER, "Tiny Helper");
const share = { name: "footage", network: true, server: "tiny-nas", fs: "smb", share: "footage", freeGb: 900 };
saveReport(studio, { at: Date.now(), drivers: [], homes: [], machine: { cpus: 8, memGb: 32, disks: [{ ...share, path: "/Volumes/footage" }] } } as never);
const file = storageFilePath(process.env.DATA_DIR, USER);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ folders: [{ id: "f1", role: "footage", name: "Trip", origin: { host: studio, path: "/Volumes/footage/Trip" }, make: false, createdAt: 1, reach: {} }] }));

const post = (url: string, body: unknown, token?: string) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
/** The helper claims, as its long poll would after the hint; the second ask is made a moment after the first is answered. */
async function claim(): Promise<DeviceJob> {
  for (let i = 0; i < 50; i++) {
    const { job } = (await (await post("/api/devices/relay/editor/claim", { kinds: ["helper-check"] }, helper.token)).json()) as { job: DeviceJob | null };
    if (job) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no check to claim");
}

describe("checking a computer", () => {
  it("reads its disks first, then tests the folder it reaches through the share at its own path, keeps the result and sets its weight", async () => {
    await claim().catch(() => null); // its first claim stores the kinds it takes (none waits yet)
    const asked = post(`/api/devices/${helper.device.id}/check`, { test: true });

    const disks = await claim();
    expect(disks.options).toEqual({ folders: "{}", test: "" });
    // it connected the same share, at another path
    saveReport(helper.device.id, { at: Date.now(), drivers: [], homes: [], machine: { os: "linux", cpus: 32, memGb: 62, disks: [{ ...share, path: "/mnt/footage" }] } } as never);
    expect((await post(`/api/devices/relay/job/helper-check/${disks.id}`, { ffmpeg: true, folders: [] }, helper.token)).status).toBe(200);

    const test = await claim();
    expect(test.options).toEqual({ folders: JSON.stringify({ f1: "/mnt/footage/Trip" }), test: "1" });
    // a folder it was not asked about is dropped
    await post(`/api/devices/relay/job/helper-check/${test.id}`, { ffmpeg: true, encode: 6.2, folders: [{ id: "f1", ok: true }, { id: "elsewhere", ok: true }] }, helper.token);

    const out = (await (await asked).json()) as { check: HelperCheck; weight: number };
    expect(out.weight).toBe(50);
    expect(out.check.folders).toEqual([{ id: "f1", name: "Trip", ok: true }]);
    expect(deviceOf(helper.device.id)?.check?.encode).toBe(6.2);
    expect(JSON.parse(readFileSync(balanceFile(USER), "utf8"))).toMatchObject({ on: true, weights: { [helper.device.id]: 50 } });
  });

  it("a computer that does not answer the check's kind is told to update first", async () => {
    const r = await post(`/api/devices/${studio}/check`, { test: true });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/offline|Update Creator Toolset/);
  });
});
