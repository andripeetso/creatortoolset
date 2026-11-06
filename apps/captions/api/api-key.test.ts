import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "api-key-"));
process.env.APP_SECRET = "api-key-test-secret";

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;

describe("AI access key", () => {
  it("reads Review with GET, and nothing else on a plain account", async () => {
    const user = createUser("keyowner", "password1");
    const key = newApiKey(user);
    const auth = { authorization: `Bearer ${key}` };

    expect((await app.request("/api/review", { headers: auth })).status).toBe(200);
    expect((await app.request("/api/review")).status).toBe(401);
    expect((await app.request("/api/projects", { headers: auth })).status).toBe(401);
    expect((await app.request("/api/review/projects", { method: "POST", headers: auth })).status).toBe(401);
    // uploading a finished cut to Review, and only that
    const up = await app.request("/api/review/uploads", {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Cut.mp4", size: 3 }),
    });
    expect(up.status).toBe(200);
    const { id } = (await up.json()) as { id: string };
    expect((await app.request(`/api/review/uploads/${id}/complete`, { method: "POST", headers: auth })).status).not.toBe(401);
    expect((await app.request(`/api/review/uploads/${id}`, { method: "DELETE", headers: auth })).status).toBe(401);

    // a new key turns the old one off
    const next = newApiKey(user);
    expect((await app.request("/api/review", { headers: auth })).status).toBe(401);
    expect((await app.request("/api/review", { headers: { authorization: `Bearer ${next}` } })).status).toBe(200);
  });

  it("resolves a comment, but never rewrites one", async () => {
    const user = createUser("resolver", "password1");
    const auth = { authorization: `Bearer ${newApiKey(user)}`, "content-type": "application/json" };
    const id = "15727409-93df-4cf4-9933-f2ce7d069ca0";
    const dir = path.join(process.env.DATA_DIR!, "review", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
      id, name: "Cut", owner: "resolver", versions: [], approval: { status: "none" }, createdAt: 0, updatedAt: 0,
    }));
    writeFileSync(path.join(dir, "comments.json"), JSON.stringify([
      { id: "c1", version: 1, t: 1, text: "Trim this", author: "Ada", createdAt: 0 },
    ]));
    const url = `/api/review/assets/${id}/comments/c1`;
    const patch = (body: unknown) => app.request(url, { method: "PATCH", headers: auth, body: JSON.stringify(body) });

    const done = await patch({ resolved: true });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { resolved?: boolean }).resolved).toBe(true);
    expect((await patch({ text: "Never mind" })).status).toBe(403);
    expect((await app.request(url, { method: "DELETE", headers: auth })).status).toBe(401);
  });

  it("Full key: the account headless (Workshop and the rest), never Admin, AI settings or paired Macs", async () => {
    const user = createUser("keyfull", "password1", { role: "admin" });
    const review = { authorization: `Bearer ${newApiKey(user)}` };
    const full = { authorization: `Bearer ${newApiKey(user, "full")}` };
    const json = { ...full, "content-type": "application/json" };

    // the Review key still reaches only its routes, and stays on beside the Full one
    expect((await app.request("/api/workshop/sessions", { headers: review })).status).toBe(401);
    expect((await app.request("/api/review", { headers: review })).status).toBe(200);

    expect((await app.request("/api/workshop/sessions", { headers: full })).status).toBe(200);
    const made = await app.request("/api/workshop/sessions", { method: "POST", headers: json, body: JSON.stringify({ title: "Headless" }) });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const doc = await app.request(`/api/workshop/sessions/${id}/docs`, { method: "POST", headers: json, body: JSON.stringify({ kind: "reel", text: "Line one" }) });
    expect(doc.status).toBe(201);
    // what an AI writes on the key is the AI's text, never the author's words or the author's rewrites
    const piece = (await doc.json()) as { id: string; blocks: Array<{ id: string; author: string }> };
    expect(piece.blocks[0].author).toBe("ai");
    const edited = await app.request(`/api/workshop/sessions/${id}/docs/${piece.id}`, {
      method: "PATCH", headers: json, body: JSON.stringify({ blocks: [{ id: piece.blocks[0].id, text: "Line one, tighter" }], caption: "Post" }),
    });
    const after = (await edited.json()) as { blocks: Array<{ author: string }>; caption: { author: string }; userEdits?: unknown[] };
    expect(after.blocks[0].author).toBe("ai");
    expect(after.caption.author).toBe("ai");
    expect(after.userEdits ?? []).toEqual([]);
    expect(existsSync(path.join(process.env.DATA_DIR!, "workshop", "users", "keyfull.edits.json"))).toBe(false);
    expect((await app.request("/api/review", { headers: full })).status).toBe(200);
    expect((await app.request("/api/projects", { headers: full })).status).toBe(200);

    for (const p of ["/api/admin/users", "/api/providers", "/api/devices"]) {
      expect((await app.request(p, { headers: full })).status).toBe(401);
    }
    // a new Full key turns the old Full key off
    newApiKey(user, "full");
    expect((await app.request("/api/workshop/sessions", { headers: full })).status).toBe(401);
  });

  it("is made only for a signed-in account", async () => {
    expect((await app.request("/api/auth/api-key", { method: "POST" })).status).toBe(401);
  });
});
