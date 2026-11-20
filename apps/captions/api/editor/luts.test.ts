import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cube, type CameraLut } from "../../contracts/camera";

// The LUTs added under Colour are a workspace's: its owner and the members given it see them, Read members only list
// and download, and nobody reaches another workspace's by id.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "luts-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "luts-test-secret";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ana owns two workspaces; bo is a member given the first; cy is on the server, given none
const ws = path.join(dir, "workshop");
mkdirSync(path.join(ws, "projects"), { recursive: true });
mkdirSync(path.join(ws, "users"), { recursive: true });
for (const id of ["tiny-a", "tiny-b"]) writeFileSync(path.join(ws, "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: 1, updatedAt: 1 }));
const member = (username: string, role: string, workspaces?: string[]) => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: 0, ...(workspaces ? { workspaces } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "team", name: "Tiny Acrobatics", plan: "team", comped: true, members: [member("ana", "owner"), member("bo", "member", ["tiny-a"])], createdAt: 0 }], invites: [], spend: {} }),
);

const { createUser, findUser, setOff } = await import("../users");
const app = (await import("../boot")).default;

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, workspace: string, method: string, url: string, body?: string | FormData) =>
  app.request(`/api/edit-steps/luts${url}`, { method, headers: { cookie: cookies[user]!, "x-ct-workspace": workspace, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) }, body });
const upload = (user: string, workspace: string, text: string, name = "Tiny look.cube") => {
  const form = new FormData();
  form.append("file", new File([text], name));
  return call(user, workspace, "POST", "", form);
};
const list = async (user: string, workspace: string) => (await (await call(user, workspace, "GET", "")).json()) as CameraLut[];

const GOOD = cube((rgb) => [rgb[0] * 0.9, rgb[1], rgb[2]], 33);
let id = "";
beforeAll(async () => {
  for (const u of ["ana", "bo", "cy"]) await login(u);
});

describe("the LUTs under Colour", () => {
  it("adds a 3D .cube to the workspace, kept as it was sent, and adding it again changes nothing", async () => {
    const res = await upload("ana", "tiny-a", GOOD);
    expect(res.status).toBe(200);
    const [lut] = (await res.json()) as CameraLut[];
    expect(lut).toMatchObject({ name: "Tiny look", size: 33, bytes: GOOD.length });
    id = lut!.id;
    expect(id).toMatch(/^lut_[0-9a-f]{12}$/);
    expect(await (await upload("ana", "tiny-a", GOOD, "again.cube")).json()).toHaveLength(1);
    expect(await (await call("ana", "tiny-a", "GET", `/${id}`)).text()).toBe(GOOD);
  });

  it("refuses a 1D shaper, a short table and a file that is not a LUT, with why", async () => {
    const shaper = await upload("ana", "tiny-a", `LUT_1D_SIZE 4096\n${GOOD}`);
    expect(shaper.status).toBe(400);
    expect(((await shaper.json()) as { error: string }).error).toContain("1D shaper");
    expect((await upload("ana", "tiny-a", GOOD.split("\n").slice(0, 100).join("\n"))).status).toBe(400);
    expect((await upload("ana", "tiny-a", "not a lut")).status).toBe(400);
    expect(await list("ana", "tiny-a")).toHaveLength(1);
  });

  it("keeps it to its workspace: another workspace, or an account not given it, gets Not found by id", async () => {
    expect(await list("ana", "tiny-b")).toEqual([]);
    expect((await call("ana", "tiny-b", "GET", `/${id}`)).status).toBe(404);
    // cy names ana's workspace, which isn't theirs: the request works in cy's own
    expect(await list("cy", "tiny-a")).toEqual([]);
    expect((await call("cy", "tiny-a", "GET", `/${id}`)).status).toBe(404);
    expect((await call("cy", "tiny-a", "DELETE", `/${id}`)).status).toBe(404);
  });

  it("a member given the workspace sees it; set to Read, lists and downloads but never adds, renames or deletes", async () => {
    expect((await list("bo", "tiny-a")).map((l) => l.id)).toEqual([id]);
    findUser("bo")!.read = ["editor"];
    try {
      expect((await call("bo", "tiny-a", "GET", `/${id}`)).status).toBe(200);
      for (const res of [await upload("bo", "tiny-a", cube((rgb) => rgb, 3)), await call("bo", "tiny-a", "PUT", `/${id}`, JSON.stringify({ name: "Mine" })), await call("bo", "tiny-a", "DELETE", `/${id}`)]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: "READ_ONLY" });
      }
    } finally {
      findUser("bo")!.read = [];
    }
    expect((await call("bo", "tiny-a", "PUT", `/${id}`, JSON.stringify({ name: "Warm" }))).status).toBe(200);
    expect((await list("ana", "tiny-a"))[0]!.name).toBe("Warm");
  });

  it("deletes it and its file", async () => {
    expect(await (await call("ana", "tiny-a", "DELETE", `/${id}`)).json()).toEqual([]);
    expect((await call("ana", "tiny-a", "GET", `/${id}`)).status).toBe(404);
    const store = path.join(dir, "edit-steps", "luts", "w-tiny-a");
    expect(existsSync(store) && readdirSync(store).filter((f) => f.endsWith(".cube"))).toEqual([]);
  });
});
