import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "stories-"));
process.env.APP_SECRET = "stories-test-secret";

const { createUser } = await import("./users");
const app = (await import("./boot")).default;

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const login = async (username: string, password: string) => ({
  cookie: cookieOf(await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
  })),
});
const json = (headers: Record<string, string>, body: unknown, method = "POST") =>
  ({ method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 5)); // newest first goes by the millisecond
type Split = { id: string; owner: string; name: string; cuts: number[]; target: number; duration: number };

describe("Story Splitter's saved splits", () => {
  it("saves, lists, reopens, updates and deletes a split, each account its own", async () => {
    createUser("alex", "password1");
    createUser("jev", "password1");
    const alex = await login("alex", "password1");
    const jev = await login("jev", "password1");

    const res = await app.request("/api/stories", json(alex, { name: "Sample A.mp4", cuts: [41.5, 20.25], target: 20, duration: 89 }));
    expect(res.status).toBe(200);
    const split = (await res.json()) as Split;
    expect(split).toMatchObject({ owner: "alex", name: "Sample A.mp4", cuts: [20.25, 41.5], target: 20, duration: 89 });
    expect(existsSync(path.join(process.env.DATA_DIR!, "stories", `${split.id}.json`))).toBe(true);
    await tick();
    const local = (await (await app.request("/api/stories", json(alex, { name: "Talk.mov", cuts: [], target: 15, duration: 30 }))).json()) as Split;

    // bad input stays out
    for (const bad of [
      { name: "x", cuts: [90], target: 20, duration: 89 },
      { name: "x", cuts: [Number.NaN], target: 20, duration: 89 },
      { name: "x", cuts: Array.from({ length: 201 }, (_, i) => i / 10), target: 20, duration: 89 },
      { name: "x".repeat(161), cuts: [], target: 20, duration: 89 },
      { name: "x", cuts: [], target: 20 },
    ]) {
      expect((await app.request("/api/stories", json(alex, bad))).status).toBe(400);
    }

    // newest first, own only
    const list = (await (await app.request("/api/stories", { headers: alex })).json()) as Split[];
    expect(list.map((s) => s.name)).toEqual(["Talk.mov", "Sample A.mp4"]);
    expect(await (await app.request("/api/stories", { headers: jev })).json()).toEqual([]);
    expect((await app.request(`/api/stories/${split.id}`, { headers: alex })).status).toBe(200);
    expect((await app.request(`/api/stories/${split.id}`, { headers: jev })).status).toBe(404);
    expect((await app.request(`/api/stories/${split.id}`, json(jev, { cuts: [] }, "PUT"))).status).toBe(404);
    expect((await app.request(`/api/stories/${split.id}`, { method: "DELETE", headers: jev })).status).toBe(404);

    // cuts changed and downloaded again: the same split, moved to the top
    await tick();
    const put = await app.request(`/api/stories/${split.id}`, json(alex, { cuts: [30], target: 30 }, "PUT"));
    expect(await put.json()).toMatchObject({ id: split.id, cuts: [30], target: 30, name: "Sample A.mp4" });
    expect((await app.request(`/api/stories/${split.id}`, json(alex, { cuts: [89.5] }, "PUT"))).status).toBe(400);
    const again = (await (await app.request("/api/stories", { headers: alex })).json()) as Split[];
    expect(again.map((s) => s.id)).toEqual([split.id, local.id]);

    expect((await app.request(`/api/stories/${split.id}`, { method: "DELETE", headers: alex })).status).toBe(200);
    expect((await app.request(`/api/stories/${split.id}`, { headers: alex })).status).toBe(404);
  });

  it("keeps nothing for guests, and shows a demo visitor the demo's splits without changing them", async () => {
    const guest = { cookie: cookieOf(await app.request("/api/auth/guest", { method: "POST" })) };
    expect((await app.request("/api/stories", { headers: guest })).status).toBe(403);
    expect((await app.request("/api/stories", json(guest, { name: "x", cuts: [], target: 20, duration: 9 }))).status).toBe(403);

    createUser("demo", "demopass1");
    const demo = await login("demo", "demopass1");
    const split = (await (await app.request("/api/stories", json(demo, { name: "Sample A.mp4", cuts: [22], target: 20, duration: 89 }))).json()) as Split;
    const visitor = { cookie: cookieOf(await app.request("/api/auth/demo", { method: "POST" })) };
    const seen = (await (await app.request("/api/stories", { headers: visitor })).json()) as Split[];
    expect(seen.map((s) => s.id)).toEqual([split.id]);
    expect((await app.request(`/api/stories/${split.id}`, { headers: visitor })).status).toBe(200);
    const refused = await app.request(`/api/stories/${split.id}`, { method: "DELETE", headers: visitor });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-demo")).toBe("read-only");
  });
});
