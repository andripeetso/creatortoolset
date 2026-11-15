// A plug-in's device job (lib/plugin.ts DeviceJobSlot) on the device routes: a Mac claims it by its kind, reads its
// input, answers, sends a file and fails, each only with its own token and only for a job it holds.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DeviceJob } from "../contracts/devices";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "device-jobs-"));
delete process.env.APP_SECRET;

const { Hono } = await import("hono");
const app = (await import("./boot")).default;
const { pairDevice } = await import("./lib/devices");
const { mountPlugins } = await import("./lib/plugin");

const input = path.join(process.env.DATA_DIR, "input.bin");
writeFileSync(input, "the original");
const seen: { file?: string; name?: string; failed?: string } = {};
let waiting = true;
const holds = (device: string, id: number) => device === mac.device.id && id === 7;
mountPlugins(new Hono(), [
  {
    id: "tiny-jobs",
    deviceJobs: [
      {
        kind: "tiny-job",
        waits: () => waiting,
        claim: (d): DeviceJob | null => (waiting && d.owner === "ana" ? ((waiting = false), { id: 7, kind: "tiny-job", editId: "", variant: "", options: { look: "blur" } }) : null),
        input: async (d, id) => (holds(d, id) ? { file: input, type: "application/octet-stream" } : null),
        answer: async (d, id, body) => (holds(d, id) ? { reply: { echo: body } } : { error: "Not found", status: 404 }),
        file: async (d, id, file, name) => (holds(d, id) ? ((seen.file = readFileSync(file, "utf8")), (seen.name = name), { reply: { saved: true } }) : { error: "Not found", status: 404 }),
        fail: (d, id, why) => holds(d, id) && ((seen.failed = why), true),
      },
    ],
  },
]);

const mac = pairDevice("ana", "Ana's Mac");
const other = pairDevice("bo", "Bo's Mac");
const as = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (url: string, body: unknown, token = mac.token) => app.request(url, { method: "POST", headers: { "content-type": "application/json", ...as(token) }, body: JSON.stringify(body) });

describe("a plug-in's device job", () => {
  it("is claimed by its kind, read, answered, sent a file and failed, by the Mac that holds it", async () => {
    expect(await (await post("/api/devices/relay/editor/claim", { kinds: ["tiny-job"] }, other.token)).json()).toEqual({ job: null });
    const claim = (await (await post("/api/devices/relay/editor/claim", { kinds: ["tiny-job"] })).json()) as { job: DeviceJob };
    expect(claim.job).toEqual({ id: 7, kind: "tiny-job", editId: "", variant: "", options: { look: "blur" } });

    expect(await (await app.request("/api/devices/relay/job/tiny-job/7", { headers: as(mac.token) })).text()).toBe("the original");
    expect((await app.request("/api/devices/relay/job/tiny-job/7", { headers: as(other.token) })).status).toBe(404);
    expect((await app.request("/api/devices/relay/job/other-kind/7", { headers: as(mac.token) })).status).toBe(404);
    expect((await app.request("/api/devices/relay/job/tiny-job/7")).status).toBe(401);

    expect(await (await post("/api/devices/relay/job/tiny-job/7", { faces: [] })).json()).toEqual({ echo: { faces: [] }, ok: true });
    expect((await post("/api/devices/relay/job/tiny-job/7", {}, other.token)).status).toBe(404);

    const sent = await app.request("/api/devices/relay/job/tiny-job/7/file?name=covered.mp4", { method: "POST", headers: { ...as(mac.token), "content-type": "video/mp4" }, body: "the covered copy" });
    expect(await sent.json()).toEqual({ saved: true, ok: true });
    expect(seen).toMatchObject({ file: "the covered copy", name: "covered.mp4" });

    expect(await (await post("/api/devices/relay/job/tiny-job/7/fail", { error: "no disk" })).json()).toEqual({ ok: true });
    expect(seen.failed).toBe("no disk");
    expect(await (await post("/api/devices/relay/job/tiny-job/8/fail", { error: "x" })).json()).toEqual({ ok: false });
  });

  it("refuses a kind the app has, or one declared twice", () => {
    const slot = { waits: () => false, claim: () => null, input: async () => null, answer: async () => ({ reply: {} }), file: async () => ({ reply: {} }), fail: () => false };
    expect(() => mountPlugins(new Hono(), [{ id: "a", deviceJobs: [{ ...slot, kind: "cutout" }] }])).toThrow(/built in/);
    expect(() => mountPlugins(new Hono(), [{ id: "a", deviceJobs: [{ ...slot, kind: "x" }] }, { id: "b", deviceJobs: [{ ...slot, kind: "x" }] }])).toThrow(/twice/);
    expect(() => mountPlugins(new Hono(), [{ id: "a", deviceJobs: [{ ...slot, kind: "Bad Kind" }] }])).toThrow(/lowercase/);
  });
});
