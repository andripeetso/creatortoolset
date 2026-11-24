// folder_list in a real turn: the folders the person dropped or typed in the chat are the ones it may look in, called
// with the turn's own job token through /api/mcp, with sign-in on (APP_SECRET), and no Storage folder set.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "folder-list-turn-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.APP_SECRET = "folder-list-turn-secret";
process.env.LIBRARY_WATCH_FOLDERS = "1";
afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); // background writes may still land in it
});

const { createUser } = await import("./users");
const app = (await import("./boot")).default;
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");

createUser("ana", "password1");
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");
const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

const dropped = path.join(dir, "Tiny Drop");
const typed = path.join(dir, "Tiny Shoots", "SHOOT");
for (const f of [path.join(dropped, "MUSIC", "theme.m4a"), path.join(typed, "FOOTAGE", "MUSIC", "tiny-acrobatics-theme.m4a"), path.join(dir, "Tiny Shoots", "OTHER", "x.mp4")]) {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, "abc");
}

describe("folder_list in a turn", () => {
  it("looks in a dropped folder and in a typed one, and only there", async () => {
    const cookie = (await app.request("/api/auth/login", json({ username: "ana", password: "password1" }))).headers.get("set-cookie")!.split(";")[0]!;
    expect((await app.request("/api/assistant/turn", json({ text: `The song is in ${typed}, I am sure.`, paths: [dropped] }, { cookie }))).status).toBe(202);
    const job = (await (await app.request("/api/devices/relay/wait", json({}, { authorization: `Bearer ${mac.token}` }))).json()) as { id: string; mcp: { token: string } };
    const call = async (args: unknown) => {
      const r = (await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "folder_list", arguments: args } }, { authorization: `Bearer ${job.mcp.token}` }))).json()) as {
        result: { content: { text: string }[]; isError?: boolean };
      };
      return { error: !!r.result.isError, text: r.result.content[0]!.text };
    };

    const inDrop = await call({ path: dropped, match: "song" });
    expect(inDrop.error).toBe(false);
    expect(JSON.parse(inDrop.text).entries.map((e: { path: string }) => e.path)).toEqual(["MUSIC/theme.m4a"]);
    const below = await call({ path: path.join(typed, "FOOTAGE"), match: "song" });
    expect(JSON.parse(below.text).entries.map((e: { path: string }) => e.path)).toEqual(["MUSIC/tiny-acrobatics-theme.m4a"]);
    // the folder the typed one is in, and one beside it, were not given
    for (const p of [path.join(dir, "Tiny Shoots"), path.join(dir, "Tiny Shoots", "OTHER")]) {
      const r = await call({ path: p });
      expect(r).toMatchObject({ error: true });
      expect(r.text).toContain("no folders in Settings → Folders yet");
    }
    await app.request(`/api/devices/relay/${job.id}/done`, json({ text: "Found it." }, { authorization: `Bearer ${mac.token}` }));
  });
});
