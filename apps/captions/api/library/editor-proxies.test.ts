import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import type { AssetCard } from "../../contracts/library";

// Proxies for the editor (MEDIA LIBRARY CEO 11-20, lane E): an edit's heavy clips (a phone's 4K HEVC) get a proxy job
// when it opens; each clip says where its proxy plays and its size (AssetCard.proxy); a computer keeps the proxy it made
// where the server hosts none.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-proxies-"));
process.env.DATA_DIR = dir;
// ana owns the team and its library (as places.test.ts sets it up)
const FIRST = "cccccccc-0000-4000-8000-000000000001";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", `${FIRST}.json`), JSON.stringify({ id: FIRST, owner: "ana", name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Team", plan: "team", comped: false, createdAt: 0, members: [{ username: "ana", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }] }], invites: [], spend: {} }),
);
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { markHere } = await import("./query");
const { pairDevice } = await import("../lib/devices");
const { keepsProxy } = await import("../work/library-package");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user", off: [], read: [] } as never);
  return next();
});
app.route("/api/library", libraryApp);
const ask = async (user: string, versions: string[]) => {
  const r = await app.request("/api/library/lib/proxies", { method: "POST", headers: { "x-user": user, "content-type": "application/json" }, body: JSON.stringify({ versions }) });
  return { status: r.status, json: (await r.json()) as { queued?: string[] } };
};

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib', 't', 'Library', 'local', ?, 0)").run(JSON.stringify({ proxy: false, proxyQuality: "standard" }));
const mac = pairDevice("ana", "Studio").device.id;
const HEVC_4K = { duration: 9, width: 3840, height: 2160, fps: 30, rotation: 90, format: "mov,mp4,m4a,3gp,3g2,mj2", vcodec: "hevc", pixFmt: "yuv420p10le", acodec: "aac" };
const H264_720 = { duration: 9, width: 1280, height: 720, fps: 30, rotation: 0, format: "mov,mp4,m4a,3gp,3g2,mj2", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
const add = (id: string, probe: Record<string, unknown>, o: { mac?: boolean; serverProxy?: boolean; cachedOn?: string } = {}) => {
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib', 'video', ?, ?, 'ana', 0)").run(`a_${id}`, id, id);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 100, ?, ?, 'ready', 'ana', 0)").run(
    id,
    `a_${id}`,
    o.mac ? `mac:${id}` : `libraries/lib/v/${id}/source`,
    `sha-${id}`,
    JSON.stringify(probe),
  );
  if (o.serverProxy) d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 50)").run(id, `libraries/lib/v/${id}/proxy.mp4`);
  if (o.cachedOn)
    d.prepare("INSERT INTO version_places (version_id, device, kind, folder_id, path, state, source) VALUES (?, ?, 'proxy', '', '', 'verified', 'work-claim')").run(id, o.cachedOn);
};
add("phone4k", HEVC_4K);
add("hd720", H264_720);
add("hasproxy", HEVC_4K, { serverProxy: true });
add("cached4k", HEVC_4K, { cachedOn: mac });
add("mac4k", { ...HEVC_4K, rotation: 0, vcodec: "mac", format: "", pixFmt: "", acodec: "" }, { mac: true });
add("mac720", { ...H264_720, vcodec: "mac", format: "", pixFmt: "", acodec: "" }, { mac: true });
const proxyJobs = () => (d.prepare("SELECT version_id FROM jobs WHERE kind = 'proxy' AND state = 'queued' ORDER BY version_id").all() as { version_id: string }[]).map((r) => r.version_id);

describe("proxies for the editor", () => {
  it("an edit's heavy clips with no proxy anywhere get a proxy job, whatever Generate proxies says; light ones and ones with a proxy don't", async () => {
    const all = ["phone4k", "hd720", "hasproxy", "cached4k", "mac4k", "mac720"];
    expect(await ask("ana", all)).toEqual({ status: 200, json: { queued: ["phone4k", "mac4k"] } });
    expect(proxyJobs()).toEqual(["mac4k", "phone4k"]);
    // asked again while they wait: nothing new
    expect((await ask("ana", all)).json).toEqual({ queued: [] });
    // someone who can't see the library gets nothing queued
    expect((await ask("stranger", all)).status).toBe(404);
  });

  it("each clip says where its proxy plays and its size: upright as the file turns it, at the library's Proxy quality", async () => {
    const card = (id: string) => ({ id: `a_${id}`, versionId: id }) as AssetCard;
    const [server, cached, none] = await markHere(d, [card("hasproxy"), card("cached4k"), card("hd720")], mac);
    expect(server!.proxy).toEqual({ w: 720, h: 1280, server: true }); // 3840×2160 filmed on its side: a 720×1280 proxy
    expect(cached!.proxy).toEqual({ w: 720, h: 1280, cached: true });
    expect(none!.proxy).toBeUndefined();
    // another computer than the one that keeps it: not here
    expect((await markHere(d, [card("cached4k")], "other-device"))[0]!.proxy).toBeUndefined();
  });

  it("a computer keeps the proxy it made wherever the server hosts no proxies", () => {
    expect([keepsProxy("none"), keepsProxy("originals"), keepsProxy("proxies"), keepsProxy("all")]).toEqual([true, true, false, false]);
  });
});

describe("an opened edit's proxies under Blur faces", () => {
  it("never asks for a proxy of an original waiting for its blur (it is made from the blurred copy); a clip kept as filmed gets one as any clip", async () => {
    add("toblur", HEVC_4K);
    add("asfilmed", HEVC_4K);
    d.prepare("UPDATE assets SET blur = 'yes' WHERE id = 'a_toblur'").run();
    d.prepare("UPDATE assets SET blur = 'no' WHERE id = 'a_asfilmed'").run();
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.blurFaces', json('true')) WHERE id = 'lib'").run();
    try {
      expect((await ask("ana", ["toblur", "asfilmed"])).json.queued).toEqual(["asfilmed"]);
    } finally {
      d.prepare("UPDATE libraries SET settings = json_remove(settings, '$.blurFaces') WHERE id = 'lib'").run();
    }
  });
});
