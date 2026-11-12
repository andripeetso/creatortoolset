import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "folders-"));
process.env.APP_SECRET = "folders-test-secret";

const { createUser, findUser, setOff } = await import("./users");
const app = (await import("./boot")).default;

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const login = async (username: string) => ({
  cookie: cookieOf(await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }),
  })),
});
const send = (who: { cookie: string }, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: who.cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
type Folders = { folders: { id: string; name: string; parentId: string | null }[]; items: Record<string, string> };
const list = async (who: { cookie: string }, tool = "notes") => (await (await send(who, "GET", `/api/folders/${tool}`)).json()) as Folders;

createUser("ana", "password1");
createUser("ben", "password1");
const ana = await login("ana");
const ben = await login("ben");

describe("folders in the tools with none of their own", () => {
  it("makes, renames, nests and lists a person's folders, each person their own", async () => {
    expect(await list(ana)).toEqual({ folders: [], items: {} });
    const res = await send(ana, "POST", "/api/folders/notes", { name: "  Launch  " });
    expect(res.status).toBe(201);
    const launch = (await res.json()) as Folders["folders"][number];
    expect(launch).toMatchObject({ name: "Launch", parentId: null });
    const week = (await (await send(ana, "POST", "/api/folders/notes", { name: "Week 12", parentId: launch.id })).json()) as Folders["folders"][number];
    expect(week.parentId).toBe(launch.id);
    expect((await send(ana, "PATCH", `/api/folders/notes/${week.id}`, { name: "Week twelve" })).status).toBe(200);
    expect((await list(ana)).folders.map((f) => f.name)).toEqual(["Launch", "Week twelve"]);
    // another person sees none of them and changes none of them
    expect(await list(ben)).toEqual({ folders: [], items: {} });
    expect((await send(ben, "PATCH", `/api/folders/notes/${week.id}`, { name: "x" })).status).toBe(404);
    // another tool has its own folders
    expect((await list(ana, "guides")).folders).toEqual([]);
  });

  it("refuses a nameless folder, a missing parent, a folder inside itself, and a tool it does not serve", async () => {
    const { folders } = await list(ana);
    const [launch, week] = folders;
    expect((await send(ana, "POST", "/api/folders/notes", { name: "   " })).status).toBe(400);
    expect((await send(ana, "POST", "/api/folders/notes", { name: "x", parentId: "nope" })).status).toBe(404);
    expect((await send(ana, "PATCH", `/api/folders/notes/${launch.id}`, { parentId: week.id })).status).toBe(409);
    expect((await send(ana, "PATCH", `/api/folders/notes/${launch.id}`, { parentId: launch.id })).status).toBe(409);
    expect((await send(ana, "GET", "/api/folders/review")).status).toBe(404);
    expect((await send(ana, "POST", "/api/folders/../users", { name: "x" })).status).toBe(404);
  });

  it("moves items into a folder and back to the top, and writes nothing but the person's own file", async () => {
    const [launch, week] = (await list(ana)).folders;
    const moved = await send(ana, "PUT", "/api/folders/notes/items", { ids: ["clip-a", "clip-b"], folderId: week.id });
    expect(((await moved.json()) as Folders).items).toEqual({ "clip-a": week.id, "clip-b": week.id });
    await send(ana, "PUT", "/api/folders/notes/items", { ids: ["clip-c"], folderId: launch.id });
    await send(ana, "PUT", "/api/folders/notes/items", { ids: ["clip-b"], folderId: null });
    expect((await list(ana)).items).toEqual({ "clip-a": week.id, "clip-c": launch.id });
    expect((await send(ana, "PUT", "/api/folders/notes/items", { ids: [], folderId: null })).status).toBe(400);
    expect((await send(ana, "PUT", "/api/folders/notes/items", { ids: ["x"], folderId: "nope" })).status).toBe(404);
    const file = path.join(process.env.DATA_DIR!, "folders", "notes", "ana.json");
    expect(JSON.parse(readFileSync(file, "utf8")).items).toEqual({ "clip-a": week.id, "clip-c": launch.id });
    expect(existsSync(path.join(process.env.DATA_DIR!, "folders", "notes", "ben.json"))).toBe(false);
  });

  it("deleting a folder keeps what was in it: its items and folders move up one level", async () => {
    const [launch, week] = (await list(ana)).folders;
    expect((await send(ana, "DELETE", `/api/folders/notes/${week.id}`)).status).toBe(200);
    let now = await list(ana);
    expect(now.folders.map((f) => f.name)).toEqual(["Launch"]);
    expect(now.items).toEqual({ "clip-a": launch.id, "clip-c": launch.id }); // up into Launch
    const inner = (await (await send(ana, "POST", "/api/folders/notes", { name: "Inner", parentId: launch.id })).json()) as Folders["folders"][number];
    expect((await send(ana, "DELETE", `/api/folders/notes/${launch.id}`)).status).toBe(200);
    now = await list(ana);
    expect(now.folders).toMatchObject([{ id: inner.id, parentId: null }]); // its folder moved to the top
    expect(now.items).toEqual({}); // its items are at the top
    expect((await send(ana, "DELETE", `/api/folders/notes/${launch.id}`)).status).toBe(404);
  });

  it("the AI Editor's folders follow the AI Editor's switch", async () => {
    setOff(findUser("ben")!, ["editor"]);
    expect((await send(ben, "GET", "/api/folders/editor")).status).toBe(403);
    expect((await send(ben, "GET", "/api/folders/notes")).status).toBe(200);
  });

  it("many changes at once all land", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => send(ana, "POST", "/api/folders/stories", { name: `F${i}` })));
    expect((await list(ana, "stories")).folders).toHaveLength(20);
  });

  it("a shared Video Notes folder opens with its link and no account: that folder and the ones inside, its owner's clips only", async () => {
    const clip = (id: string, owner: string) => {
      mkdirSync(path.join(process.env.DATA_DIR!, "clips", id), { recursive: true });
      writeFileSync(path.join(process.env.DATA_DIR!, "clips", id, "meta.json"), JSON.stringify({ id, name: `Clip ${id}`, owner, duration: 12, bytes: 1, mime: "video/mp4", status: "done", progress: 1, createdAt: 1, updatedAt: 1 }));
    };
    clip("share-a1", "ana");
    clip("share-a2", "ana");
    clip("share-b1", "ben");
    const make = async (name: string, parentId?: string) => (await (await send(ana, "POST", "/api/folders/notes", { name, parentId })).json()) as Folders["folders"][number];
    const shared = await make("Client");
    const inner = await make("Round 2", shared.id);
    const outside = await make("Private");
    // ben's clip id put in ana's folder must not show: only the folder owner's clips are listed
    await send(ana, "PUT", "/api/folders/notes/items", { ids: ["share-a1", "share-b1"], folderId: shared.id });
    await send(ana, "PUT", "/api/folders/notes/items", { ids: ["share-a2"], folderId: outside.id });

    const anon = (url: string) => app.request(url);
    const on = (await (await send(ana, "POST", `/api/folders/notes/${shared.id}/share`)).json()) as { share: string };
    expect(on.share).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // sharing again keeps the same link
    expect(((await (await send(ana, "POST", `/api/folders/notes/${shared.id}/share`)).json()) as { share: string }).share).toBe(on.share);

    const view = await anon(`/api/clips/f/${on.share}`);
    expect(view.status).toBe(200);
    expect(await view.json()).toEqual({
      name: "Client",
      trail: [{ id: shared.id, name: "Client" }],
      folders: [{ id: inner.id, name: "Round 2", count: 0, pictures: [] }],
      items: [{ id: "share-a1", name: "Clip share-a1", duration: 12, createdAt: 1, hasThumb: false }],
    });
    expect((await anon(`/api/clips/f/${on.share}?f=${inner.id}`)).status).toBe(200);
    // a folder outside the shared one is not reachable through its link
    expect((await anon(`/api/clips/f/${on.share}?f=${outside.id}`)).status).toBe(404);
    // only Video Notes folders can be shared
    const story = (await (await send(ana, "POST", "/api/folders/stories", { name: "S" })).json()) as Folders["folders"][number];
    expect((await send(ana, "POST", `/api/folders/stories/${story.id}/share`)).status).toBe(404);
    // turned off: the link is dead; another person can't turn it on
    expect((await send(ben, "POST", `/api/folders/notes/${shared.id}/share`)).status).toBe(404);
    expect((await send(ana, "DELETE", `/api/folders/notes/${shared.id}/share`)).status).toBe(200);
    expect((await anon(`/api/clips/f/${on.share}`)).status).toBe(404);
    expect((await anon("/api/clips/f/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });
});
