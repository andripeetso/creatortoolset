import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Device } from "../../contracts/providers";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-devices-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-devices-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in root) run only without one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { pairDevice, devicesSaved } = await import("../lib/devices");
const { registerDeviceKinds, releaseQuietDevices } = await import("./engine");
const { installPack } = await import("../lib/packs");
import type { Pack } from "../../contracts/packs";

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password1" }),
  });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { cookie: cookies[user]!, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;

/** A device's relay call with its ctd_ token. */
const deviceCall = (token: string | null, url: string, body: unknown = {}) =>
  app.request(url, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const claim = (token: string | null, kinds: unknown) => json<{ job: unknown; error?: string }>(deviceCall(token, "/api/devices/relay/editor/claim", { kinds }));
const jobRow = (kind: string) =>
  libraryDb().prepare("SELECT state, device, error FROM edit_jobs WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind) as
    | { state: string; device: string | null; error: string | null }
    | undefined;

let mine: { device: Device; token: string };
let theirs: { device: Device; token: string };
let editId: string;

beforeAll(async () => {
  registerDeviceKinds(["fake-kind", "fake-render"]);
  for (const u of ["maker", "other"]) await login(u);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_a1', 'lib_a', 'video', 'Take 1', 'maker', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_a1', 'ast_a1', 1, 'k1', 1, 'x1', 'ready', 'maker', 0);
  `);
  mine = pairDevice("maker", "Studio Mac");
  theirs = pairDevice("other", "Other Mac");
  const made = await json<{ id: string }>(
    call("maker", "POST", "/api/editor", { name: "Device test", sources: ["ver_a1"] }),
  );
  editId = made.id;
  // a queued render step (for a kind only some devices declare), and a queued fake step for one variant
  enqueueJob(libraryDb(), "maker", `${editId}:`, "fake-render", "maker", false, "edit_jobs");
  enqueueJob(libraryDb(), "maker", `${editId}:v1`, "fake-kind", "maker", false, "edit_jobs");
});
afterAll(async () => {
  await devicesSaved();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(rootReplaced)("AI Editor on devices", () => {
  it("a device claims only the kinds it declares, and the claim is stored with the device", async () => {
    // fake-render is queued first, but this device does not declare it; analyze is a server kind and is ignored
    const got = await claim(mine.token, ["fake-kind", "analyze"]);
    expect(got.job).toEqual({ id: expect.any(Number), kind: "fake-kind", editId, variant: "v1" });
    expect(jobRow("fake-kind")).toEqual({ state: "running", device: mine.device.id, error: null });
    expect(jobRow("fake-render")).toEqual({ state: "queued", device: null, error: null });

    const list = await json<Array<Device & { online: boolean }>>(call("maker", "GET", "/api/devices"));
    expect(list.find((d) => d.id === mine.device.id)?.kinds).toEqual(["fake-kind"]);
  });

  it("a device that declares nothing claims nothing, and an account's device never takes another account's steps", async () => {
    expect(await claim(mine.token, [])).toEqual({ job: null });
    expect(await claim(theirs.token, ["fake-render"])).toEqual({ job: null });
    expect(jobRow("fake-render")).toEqual({ state: "queued", device: null, error: null });
  });

  it("a claimed step is held by its device: another device cannot beat or finish it", async () => {
    const got = await claim(mine.token, ["fake-render"]);
    const id = (got.job as { id: number }).id;
    expect(await json(deviceCall(theirs.token, `/api/devices/relay/editor/job/${id}/beat`))).toEqual({ ok: false });
    expect(await json(deviceCall(theirs.token, `/api/devices/relay/editor/job/${id}/done`))).toEqual({ ok: false });
    expect(await json(deviceCall(mine.token, `/api/devices/relay/editor/job/${id}/beat`))).toEqual({ ok: true });
    expect(await json(deviceCall(mine.token, `/api/devices/relay/editor/job/${id}/done`))).toEqual({ ok: true });
    expect(jobRow("fake-render")).toEqual({ state: "done", device: null, error: null });
    expect(await json(deviceCall(mine.token, `/api/devices/relay/editor/job/${id}/done`))).toEqual({ ok: false });
  });

  it("a device that goes quiet loses the steps it holds, back to the queue at once", async () => {
    // the fake-kind step mine claimed in the first test
    expect(releaseQuietDevices(libraryDb(), () => false)).toBe(1);
    expect(jobRow("fake-kind")).toEqual({ state: "queued", device: null, error: null });
    // and another device picks it up again
    expect((await claim(mine.token, ["fake-kind"])).job).toMatchObject({ kind: "fake-kind", variant: "v1" });
  });

  it("a step whose footage is gone fails when it would be claimed, and nothing is handed out", async () => {
    enqueueJob(libraryDb(), "maker", `${editId}:v2`, "fake-kind", "maker", false, "edit_jobs");
    libraryDb().exec("UPDATE assets SET trashed_at = 1 WHERE id = 'ast_a1'");
    try {
      expect(await claim(mine.token, ["fake-kind"])).toEqual({ job: null });
      expect(libraryDb().prepare("SELECT state, error FROM edit_jobs WHERE version_id = ?").get(`${editId}:v2`)).toEqual({
        state: "failed",
        error: "Some footage is gone or no longer yours to read",
      });
    } finally {
      libraryDb().exec("UPDATE assets SET trashed_at = NULL WHERE id = 'ast_a1'");
    }
  });

  it("refuses a call with no device token, and kinds that are not a list of step names", async () => {
    expect((await deviceCall(null, "/api/devices/relay/editor/claim", { kinds: ["fake-kind"] })).status).toBe(401);
    expect((await deviceCall("ctd_not-a-real-token", "/api/devices/relay/editor/claim", { kinds: [] })).status).toBe(401);
    expect((await deviceCall(mine.token, "/api/devices/relay/editor/claim", { kinds: ["Bad Kind"] })).status).toBe(400);
    expect((await deviceCall(mine.token, "/api/devices/relay/editor/claim", { kinds: "fake-kind" })).status).toBe(400);
  });
});

describe.skipIf(rootReplaced)("Resolve bridge switch", () => {
  // a Resolve pack (a plug-in or a download) is what switches the helper on; no pack, no step
  const resolvePack = {
    format: 1, id: "resolve-bridge", name: "Resolve bridge", version: "1.0.0", author: "Tiny Acrobatics", license: "MIT",
    description: "Switches on the Resolve helper for this account's Macs.", permissions: ["resolve"],
    resolve: [{ name: "resolve-19", title: "Resolve 19 on macOS", minVersion: "19.1", platform: "macos" }],
  } as unknown as Pack;

  it("a Mac that declares resolve gets no resolve step until an installed pack has Resolve items", async () => {
    enqueueJob(libraryDb(), "maker", `${editId}:r1`, "resolve", "maker", false, "edit_jobs");
    const dev = pairDevice("maker", "Resolve Mac");
    expect(await claim(dev.token, ["resolve"])).toEqual({ job: null });
    expect(jobRow("resolve")).toEqual({ state: "queued", device: null, error: null });
    const list = await json<Array<Device & { online: boolean }>>(call("maker", "GET", "/api/devices"));
    expect(list.find((d) => d.id === dev.device.id)?.kinds ?? []).toEqual([]);

    await installPack("maker", resolvePack, 0);
    const got = await claim(dev.token, ["resolve"]);
    expect(got.job).toMatchObject({ kind: "resolve", editId, variant: "r1" });
    expect(jobRow("resolve")).toEqual({ state: "running", device: dev.device.id, error: null });
  });
});
