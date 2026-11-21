import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EditorChatView } from "../../contracts/editor";

// The AI Editor's chat (editor/chat.ts): an edit's chat is one of the person's assistant chats, made on its first message,
// found again by the next one, by the phone's ?edit= and by a reply that opened the edit; New conversation lets it go.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "editor-chat-"));
process.env.APP_SECRET = "editor-chat-secret";

const app = (await import("../boot")).default;
const { createUser } = await import("../users");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { noteWork } = await import("../assistant");

createUser("ed-chat", "password1");
createUser("ed-other", "password1");
const mac = pairDevice("ed-chat", "Tiny Acrobatics Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ed-chat");
const json = (method: string, body: unknown, cookie: string) => ({ method, headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
const login = async (username: string) =>
  (await app.request("/api/auth/login", json("POST", { username, password: "password1" }, ""))).headers.get("set-cookie")!.split(";")[0]!;
const cookie = await login("ed-chat");
const get = async (url: string, c = cookie) => app.request(url, { headers: { cookie: c } });
const newEdit = async (name: string) => ((await (await app.request("/api/editor/empty", json("POST", { name }, cookie))).json()) as { id: string }).id;
const chats = async () => ((await (await get("/api/assistant/chats")).json()) as { chats: Array<{ id: string }> }).chats.map((c) => c.id);

describe("AI Editor chat", () => {
  it("no edit and an edit with no chat read as empty; an edit that isn't theirs is not found", async () => {
    const none = await get("/api/editor/chat?edit=");
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ messages: [], turn: null });
    const id = await newEdit("Tiny Acrobatics handstand");
    expect(await (await get(`/api/editor/chat?edit=${id}`)).json()).toEqual({ messages: [], turn: null });
    expect((await get(`/api/editor/chat?edit=${id}`, await login("ed-other"))).status).toBe(404);
    expect((await get("/api/editor/chat?edit=nope")).status).toBe(404);
  });

  it("a message makes the edit's chat among the person's chats, and the next one goes to the same chat", async () => {
    const id = await newEdit("Tiny Acrobatics cartwheel");
    const sent = await app.request("/api/editor/chat", json("POST", { text: "Make it shorter", edit: id }, cookie));
    expect(sent.status).toBe(202);
    const v = (await sent.json()) as EditorChatView;
    expect(v.chat).toBeTruthy();
    expect(v.messages).toMatchObject([{ role: "user", text: "Make it shorter", edit: id }]);
    expect(v.turn).toMatchObject({ steps: [] });
    expect(await chats()).toContain(v.chat);
    const again = (await (await app.request("/api/editor/chat", json("POST", { text: "And brighter", edit: id }, cookie))).json()) as EditorChatView;
    expect(again.chat).toBe(v.chat);
    expect(((await (await get(`/api/editor/chat?edit=${id}`)).json()) as EditorChatView).messages.map((m) => m.text)).toEqual(["Make it shorter", "And brighter"]);

    // New conversation: the chat stays among the person's chats, the edit's thread starts empty
    const fresh = (await (await app.request(`/api/editor/chat?edit=${id}`, { method: "DELETE", headers: { cookie } })).json()) as EditorChatView;
    expect(fresh).toEqual({ messages: [], turn: null });
    expect(await chats()).toContain(v.chat);
  });

  it("a chat whose reply opened an edit is that edit's chat", async () => {
    const id = await newEdit("Tiny Acrobatics roll");
    const { id: chat } = (await (await app.request("/api/assistant/chats", { method: "POST", headers: { cookie } })).json()) as { id: string };
    expect((await app.request(`/api/assistant/chats/${chat}/turn`, json("POST", { text: "Cut my roll video" }, cookie))).status).toBe(202);
    const reply = ((await (await get(`/api/assistant/chats/${chat}`)).json()) as { messages: Array<{ id: string }> }).messages.at(-1)!.id;
    noteWork("ed-chat", reply, { id: `edit:${id}:new`, kind: "edit", title: "Roll", href: `/editor/${id}`, status: "running" });
    expect(((await (await get(`/api/editor/chat?edit=${id}`)).json()) as EditorChatView).chat).toBe(chat);
  });
});
