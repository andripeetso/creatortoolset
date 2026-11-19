import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Media Library clips dragged into the chat go with the message by their ids: the reply is told their version_id (what
// editor_create takes), nothing uploads, and a clip from another workspace's library is refused.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "assistant-clips-"));
process.env.APP_SECRET = "assistant-test-secret";

const { createUser } = await import("./users");
const app = (await import("./boot")).default;
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");
const { CLIP_ELSEWHERE, clipsSaid } = await import("./assistant");
const { libraryDb } = await import("./library/db");
const { homeOf } = await import("./library/access");
type View = import("../contracts/assistant").AssistantView;

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

/** An account with its own Mac running the AI, and a library with one clip (`v_<name>`). */
async function person(name: string) {
  createUser(name, "password1");
  const mac = pairDevice(name, `${name}'s Mac`);
  await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, name);
  const d = libraryDb();
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, 'Library', 'local', 0)").run(`lib_${name}`, homeOf(name));
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, 'video', ?, ?, ?, 0)").run(`ast_${name}`, `lib_${name}`, `Tiny Acrobatics ${name} cartwheel`, `v_${name}`, name);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, 'h', 'ready', ?, 0)").run(`v_${name}`, `ast_${name}`, name);
  const login = await app.request("/api/auth/login", { method: "POST", ...json({ username: name, password: "password1" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const device = { authorization: `Bearer ${mac.token}` };
  return {
    send: (body: Record<string, unknown>) => app.request("/api/assistant/turn", { method: "POST", ...json(body, { cookie }) }),
    claim: async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as { id: string; user: string },
    answer: (id: string, text: string) => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text }, device) }),
  };
}

describe("library clips dragged into the chat", () => {
  it("go by their ids: the message keeps them, the reply is told their version_id, and nothing uploads", async () => {
    const p = await person("tia");
    const r = await p.send({ text: "Use these", clips: ["v_tia", "v_tia"] });
    expect(r.status).toBe(202);
    const v = (await r.json()) as View;
    expect(v.messages.at(-2)).toMatchObject({ text: "Use these", clips: [{ id: "ast_tia", versionId: "v_tia", title: "Tiny Acrobatics tia cartwheel" }] });
    expect(v.messages.at(-2)!.files).toBeUndefined();
    const job = await p.claim();
    expect(job.user).toContain(clipsSaid([{ id: "ast_tia", versionId: "v_tia", title: "Tiny Acrobatics tia cartwheel" }]));
    expect(job.user).toContain("version_id v_tia");
    await p.answer(job.id, "On it.");
    expect(existsSync(path.join(process.env.DATA_DIR!, "assistant", "files", "tia"))).toBe(false);
  });

  it("a clip alone is a message; one from another workspace's library, or one that doesn't exist, is refused with one line", async () => {
    const p = await person("uma");
    await person("val");
    const other = await p.send({ text: "Use this", clips: ["v_val"] });
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ error: CLIP_ELSEWHERE });
    expect((await p.send({ clips: ["v_gone"] })).status).toBe(400);
    expect((await p.send({ clips: "v_uma" })).status).toBe(400);
    const alone = await p.send({ clips: ["v_uma"] });
    expect(alone.status).toBe(202);
    const job = await p.claim();
    expect(job.user).toContain("version_id v_uma");
    await p.answer(job.id, "Done.");
  });
});
