import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "demo-"));
process.env.APP_SECRET = "demo-test-secret";

const { createUser, deleteUser } = await import("./users");
const { retentionRule } = await import("./retention");
const { demoCopyId } = await import("./review");
const app = (await import("./boot")).default;

const DATA = process.env.DATA_DIR!;
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const login = async (username: string, password: string) =>
  cookieOf(await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
  }));
const json = (headers: Record<string, string>, body: unknown, method = "POST") =>
  ({ method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

describe('"See the demo"', () => {
  it("copies an admin's video into the demo, and each visitor gets their own copy of it", async () => {
    expect((await app.request("/api/auth/demo", { method: "POST" })).status).toBe(404);
    createUser("demo", "demopass1");
    createUser("boss", "bosspass1", { role: "admin" });
    const admin = { cookie: await login("boss", "bosspass1") };

    // an admin's video, copied: versions and comments come along, the share link, folder and commenters' accounts don't
    const id = "0b7c6c1e-2d8a-4a7e-9d8e-5d2f1c3b4a59";
    const dir = path.join(DATA, "review", id);
    mkdirSync(path.join(dir, "v1"), { recursive: true });
    writeFileSync(path.join(dir, "v1", "source"), "video");
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
      id, name: "Reel", owner: "boss", projectId: "folder-1", share: { token: "t", enabled: true, download: false },
      versions: [{ n: 1, name: "Reel.mp4", status: "ready", duration: 9, captions: { projectId: "p", clipId: "c" }, createdAt: 0 }],
      approval: { status: "approved" }, createdAt: 0, updatedAt: 0,
    }));
    writeFileSync(path.join(dir, "comments.json"), JSON.stringify([
      { id: "c1", version: 1, t: 1, text: "Love this cut", author: "boss", user: "boss", createdAt: 0 },
    ]));
    const copied = await app.request(`/api/review/assets/${id}/demo`, { method: "POST", headers: admin });
    expect(copied.status).toBe(200);
    const demoId = ((await copied.json()) as { id: string }).id;
    const demoDir = path.join(DATA, "review", demoId);
    const meta = JSON.parse(readFileSync(path.join(demoDir, "meta.json"), "utf-8"));
    expect(meta).toMatchObject({ owner: "demo", name: "Reel", approval: { status: "approved" } });
    expect(meta.share ?? meta.projectId ?? meta.versions[0].captions).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(demoDir, "comments.json"), "utf-8"))).toEqual([
      { id: "c1", version: 1, t: 1, text: "Love this cut", author: "boss", createdAt: 0 },
    ]);
    expect(statSync(path.join(demoDir, "v1", "source")).ino).toBe(statSync(path.join(dir, "v1", "source")).ino);

    // a visitor: the demo account read-only, no AI key
    expect(((await (await app.request("/api/auth/check")).json()) as { demo: boolean }).demo).toBe(true);
    const visitor = { cookie: cookieOf(await app.request("/api/auth/demo", { method: "POST" })) };
    const me = (await (await app.request("/api/auth/check", { headers: visitor })).json()) as {
      user: { username: string; role: string; demo: boolean; off: string[] };
    };
    expect(me.user).toMatchObject({ username: "demo", role: "user", demo: true });
    // every app shows Sample but Video Notes and Guide Builder
    expect(me.user.off).toEqual(["notes", "guides"]);
    const refused = await app.request("/api/documents", json(visitor, { title: "x" }));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-demo")).toBe("read-only");
    expect((await app.request("/api/auth/api-key", { method: "POST", headers: visitor })).status).toBe(401);
    expect((await app.request("/api/review/uploads", json(visitor, { name: "a.mp4", size: 3 }))).status).toBe(403);

    // ...and Review is their own copy: they comment, the demo's video stays as it was, nobody is told
    const listed = (await (await app.request("/api/review", { headers: visitor })).json()) as { id: string; name: string }[];
    expect(listed.map((a) => a.name)).toEqual(["Reel"]);
    const mine = listed[0].id;
    expect(mine).not.toBe(demoId);
    const posted = await app.request(`/api/review/assets/${demoId}/comments`, json(visitor, { version: 1, t: 2, text: "Tighter here" }));
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as { author: string }).author).toBe("You");
    expect(readFileSync(path.join(DATA, "review", mine, "comments.json"), "utf-8")).toContain("Tighter here");
    expect(readFileSync(path.join(demoDir, "comments.json"), "utf-8")).not.toContain("Tighter here");
    expect(existsSync(path.join(DATA, "review", "notifications", "boss.json"))).toBe(false);
    const other = { cookie: cookieOf(await app.request("/api/auth/demo", { method: "POST" })) };
    const theirs = (await (await app.request(`/api/review/assets/${demoId}`, { headers: other })).json()) as {
      comments: { text: string }[];
    };
    expect(theirs.comments.map((c) => c.text)).toEqual(["Love this cut"]);

    // their copy goes after a day; the demo stays; without the account there's no demo
    const visitorName = listed.length && JSON.parse(readFileSync(path.join(DATA, "review", mine, "meta.json"), "utf-8")).owner;
    expect(mine).toBe(demoCopyId(visitorName, demoId));
    expect(retentionRule(Date.now())(visitorName, Date.now() - 2 * 86_400_000)).toBe(true);
    expect(retentionRule(Date.now())("demo", 0)).toBe(false);
    deleteUser("demo");
    expect((await app.request("/api/review", { headers: visitor })).status).toBe(401);
  });

});
