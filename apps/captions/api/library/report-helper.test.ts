import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Linux helper's own scan (public/helper/helper.py scan_pages) posted as it is: the server takes its pages.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "relay-report-helper-"));
process.env.APP_SECRET = "relay-report-helper-test-secret";

const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { whereIs } = await import("./whereis");
const { placeWordOf } = await import("../../contracts/places");

createUser("tiny", "password1");
const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tiny", password: "password1" }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const json = { "content-type": "application/json" };

/** helper.py's report pages for folder `dir` (id `id`), as the helper builds them. */
function helperPages(id: string, dir: string): Array<Record<string, unknown>> {
  const code = `import json, os, sys; sys.path.insert(0, sys.argv[1]); import helper
f = {"id": sys.argv[2], "use": "media", "hostPath": sys.argv[3], "mountPath": sys.argv[3]}
print(json.dumps(list(helper.scan_pages(f, {}, {}, set(), pause=0))))`;
  const env = { ...process.env, CT_HELPER_HOME: path.join(process.env.DATA_DIR!, "helper") };
  return JSON.parse(execFileSync("python3", ["-I", "-c", code, path.resolve(import.meta.dirname, "../../public/helper"), id, dir], { env, encoding: "utf8" }));
}

describe("the Linux helper's report", () => {
  it("is taken: new files come back to index, then read as here; a deleted one as missing", async () => {
    const dir = path.join(process.env.DATA_DIR!, "Tiny Footage");
    mkdirSync(path.join(dir, "Shoot"), { recursive: true });
    writeFileSync(path.join(dir, "Shoot", "a.mp4"), "tinyacrobatics a");
    const r = (await (await app.request("/api/devices", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Tiny NAS", machineId: "helper-1234-abcd" }) })).json()) as { device: { id: string }; token: string };
    const auth = { ...json, authorization: `Bearer ${r.token}` };
    expect((await app.request("/api/devices/storage/folders", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ role: "footage", host: r.device.id, path: dir }) })).status).toBe(200);
    const { folders } = (await (await app.request("/api/devices/relay/folders", { headers: auth })).json()) as { folders: { id: string }[] };
    const id = folders[0]!.id;
    const report = async (pages: Array<Record<string, unknown>>) => {
      const index: { folder: string; path: string }[] = [];
      for (const page of pages) {
        const res = await app.request("/api/devices/relay/report", { method: "POST", headers: auth, body: JSON.stringify({ reportVersion: 2, machineId: "helper-1234-abcd", drivers: [], homes: [], folders: [page] }) });
        expect(res.status).toBe(200);
        index.push(...((await res.json()) as { index: typeof index }).index);
      }
      return index;
    };

    const pages = helperPages(id, dir);
    const file = (pages.at(-1)!.files as { path: string; bytes: number; quick: string }[])[0]!;
    expect(await report(pages)).toEqual([{ folder: id, path: file.path }]);
    // what helper.py index() sends
    const ix = await app.request("/api/devices/relay/index", { method: "POST", headers: auth, body: JSON.stringify({ folder: id, name: "a.mp4", path: file.path, size: file.bytes, quick: file.quick, frames: [] }) });
    expect(ix.status).toBe(200);
    const versionId = ((await ix.json()) as { versions: { versionId: string }[] }).versions[0]!.versionId;
    expect(await report(helperPages(id, dir))).toEqual([]);
    expect(placeWordOf(whereIs(versionId), r.device.id)).toEqual({ word: "here" });

    // the file deleted, another one there: a whole listing marks it missing
    execFileSync("mv", [path.join(dir, "Shoot", "a.mp4"), path.join(process.env.DATA_DIR!, "moved-out.mp4")]);
    writeFileSync(path.join(dir, "b.mp4"), "tinyacrobatics b");
    await report(helperPages(id, dir));
    expect(placeWordOf(whereIs(versionId), r.device.id)).toEqual({ word: "missing", computer: "Tiny NAS" });
  });
});
