import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantView } from "../../contracts/assistant";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-review-"));
process.env.APP_SECRET = "mcp-review-secret";

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { addVersion, reviewJobsDone } = await import("../review");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

// ana owns her videos and has the assistant; nico is another account on the same server
const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", ...json({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const anaCookie = await cookieOf("ana");
const nicoCookie = await cookieOf("nico");
/** One of the site's routes as the person at the screen: what a tool did is checked here, not in the tool's own answer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const site = async (cookie: string, route: string, method = "GET", body?: unknown): Promise<any> =>
  (await app.request(route, { method, ...(body === undefined ? { headers: { cookie } } : json(body, { cookie })) })).json();
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization }) })).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  const text = r.result.content[0]!.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.result.isError, text, value: (r.result.isError || !/^[[{]/.test(text) ? text : JSON.parse(text)) as any };
};
/** A video in Review with no real file behind it: its processing fails at once, and is over before the test goes on. */
const video = async (owner: string, name: string, into?: string) => {
  const added = await addVersion(into, { owner, name, mime: "video/mp4", bytes: 1 }, async () => {});
  await reviewJobsDone();
  return added!.meta.id;
};
const names = async (cookie: string, route = "/api/review") => ((await site(cookie, route)) as Array<{ name: string }>).map((m) => m.name);

/** A turn of ana's with the Mac holding its job: the token to call tools as that reply. */
const turn = async (text: string) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie: anaCookie }) })).status).toBe(202);
  const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; mcp: { token: string } };
  return { token: `Bearer ${job.mcp.token}`, end: () => app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) }) };
};
const lastReply = async () => ((await site(anaCookie, "/api/assistant")) as AssistantView).messages.at(-1)!;

/** nico's video with its own share link on, and a second one in a shared folder. */
const nicos = async () => {
  const id = await video("nico", "NicoCut_A.mp4");
  const token = (await site(nicoCookie, `/api/review/assets/${id}`, "PATCH", { share: { enabled: true } })).share.token as string;
  const folder = await site(nicoCookie, "/api/review/projects", "POST", { name: "Nico's clients" });
  const filed = await video("nico", "NicoCut_B.mp4");
  await site(nicoCookie, `/api/review/assets/${filed}`, "PATCH", { projectId: folder.id });
  const ptoken = (await site(nicoCookie, `/api/review/projects/${folder.id}`, "PATCH", { share: { enabled: true } })).share.token as string;
  return { id, link: `http://localhost/r/${token}`, filed, folderLink: `http://localhost/rp/${ptoken}/${filed}` };
};

describe("review_comment", () => {
  it("writes a timed comment on the newest version and a reply on its comment's own version, under the account's own name", async () => {
    const id = await video("ana", "TinyReel_A.mp4");
    await video("ana", "TinyReel_B.mp4", id);
    const timed = (await tool(anaKey, "review_comment", { link: id, text: "Cut the pause", at: 2.5, end: 4 })).value;
    expect(timed).toEqual({ id: expect.any(String), version: 2, author: "ana", video: "TinyReel_B", at: "0:02.50–0:04.00", page: `/review/${id}?v=2&c=${timed.id}` });
    const old = (await tool(anaKey, "review_comment", { link: `http://localhost/review/${id}`, text: "Start on the jump", version: 1, at: 0 })).value;
    expect(old).toMatchObject({ version: 1, at: "0:00.00" });
    // the reply names no version: it goes where its comment is, and the page opens the thread by its first comment
    const reply = (await tool(anaKey, "review_comment", { link: id, text: "Done in the new cut", reply_to: old.id })).value;
    expect(reply).toMatchObject({ version: 1, reply_to: old.id, page: `/review/${id}?v=1&c=${old.id}` });

    const stored = (await site(anaCookie, `/api/review/assets/${id}`)).comments as Array<Record<string, unknown>>;
    expect(stored.find((c) => c.id === timed.id)).toMatchObject({ version: 2, t: 2.5, tEnd: 4, text: "Cut the pause", author: "ana", user: "ana", mine: true });
    expect(stored.find((c) => c.id === reply.id)).toMatchObject({ version: 1, parentId: old.id, text: "Done in the new cut", author: "ana", user: "ana" });
    // her own comment on her own video is nothing to tell her about
    expect((await site(anaCookie, "/api/review/notifications")).items).toEqual([]);

    expect(await tool(anaKey, "review_comment", { link: id, text: "x", reply_to: "nope" })).toMatchObject({ error: true, text: "No comment with that id on this video: get_review lists them." });
    expect(await tool(anaKey, "review_comment", { link: id, text: "x", version: 9 })).toMatchObject({ error: true, text: "This video has no version 9." });
    expect(await tool(anaKey, "review_comment", { link: id, text: " " })).toMatchObject({ error: true, text: "Write a comment first" });
    expect((await tool(anaKey, "review_comment", { link: "not a link", text: "x" })).text).toContain("That isn't a review link");
  });

  it("on a share link comments on someone else's video as the signed-in account, and its owner is told", async () => {
    const n = await nicos();
    const one = (await tool(anaKey, "review_comment", { link: n.link, text: "Love the ending", at: 1 })).value;
    expect(one).toMatchObject({ author: "ana", video: "NicoCut_A", page: `${new URL(n.link).pathname}?v=1&c=${one.id}` });
    const two = (await tool(anaKey, "review_comment", { link: n.folderLink, text: "Louder music" })).value;
    expect(two.page).toBe(`${new URL(n.folderLink).pathname}?v=1&c=${two.id}`);
    const stored = (await site(nicoCookie, `/api/review/assets/${n.id}`)).comments as Array<Record<string, unknown>>;
    expect(stored).toEqual([expect.objectContaining({ id: one.id, text: "Love the ending", author: "ana", user: "ana", t: 1, mine: false })]);
    const inbox = (await site(nicoCookie, "/api/review/notifications")).items as Array<Record<string, unknown>>;
    expect(inbox.map((x) => [x.kind, x.by, x.text])).toEqual([["comment", "ana", "Louder music"], ["comment", "ana", "Love the ending"]]);
    // the owner answers on the same link: a reply, on the owner's own routes
    const back = (await tool(nicoKey, "review_comment", { link: n.link, text: "Thank you", reply_to: one.id })).value;
    expect(back).toMatchObject({ author: "nico", reply_to: one.id, page: `/review/${n.id}?v=1&c=${one.id}` });
  });
});

describe("review_update", () => {
  it("renames a video, files it in a folder by name or id, takes it out again and marks it finished or not", async () => {
    const id = await video("ana", "TinyTumble_A.mp4");
    const folder = (await tool(anaKey, "review_folders", { name: "Tiny Acrobatics" })).value;
    expect(await tool(anaKey, "review_update", { link: id, name: "Tiny tumble, final", folder: "tiny acrobatics", finished: true })).toMatchObject({
      value: { id, name: "Tiny tumble, final", folder: "Tiny Acrobatics", finished: true, link: `http://localhost/review/${id}` },
    });
    const asset = async () => (await site(anaCookie, `/api/review/assets/${id}`)).asset;
    expect(await asset()).toMatchObject({ name: "Tiny tumble, final", projectId: folder.id, done: { finished: true } });
    // out of the folder, and not finished after all: the name stays
    expect((await tool(anaKey, "review_update", { link: id, folder: "none", finished: false })).value).toMatchObject({ name: "Tiny tumble, final", folder: "none", finished: false });
    expect(await asset()).toMatchObject({ name: "Tiny tumble, final", projectId: null, done: { finished: false } });
    expect((await tool(anaKey, "review_update", { link: id, folder: folder.id })).value.folder).toBe("Tiny Acrobatics");
    expect((await asset()).projectId).toBe(folder.id);

    expect(await tool(anaKey, "review_update", { link: id, folder: "Nowhere" })).toMatchObject({ error: true, text: 'No folder called "Nowhere": review_folders lists them, and makes one when given a name.' });
    expect(await tool(anaKey, "review_update", { link: id })).toMatchObject({ error: true, text: "Nothing to change: give a name, a folder or finished." });
    expect((await asset()).projectId).toBe(folder.id);
  });

  it("says in plain words when the video is someone else's, and changes nothing on it", async () => {
    const n = await nicos();
    expect(await tool(anaKey, "review_update", { link: n.link, name: "Mine now" })).toMatchObject({ error: true, text: "That video is someone else's: only its owner can rename it." });
    expect(await tool(anaKey, "review_update", { link: n.folderLink, folder: "none" })).toMatchObject({ error: true, text: "That video is someone else's: only its owner can move it." });
    expect(await tool(anaKey, "review_update", { link: n.link, finished: true })).toMatchObject({ error: true, text: "That video is someone else's: only its owner can mark it finished." });
    // by its id alone it is not hers to find
    expect(await tool(anaKey, "review_update", { link: n.id, name: "Mine now" })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    expect((await site(nicoCookie, `/api/review/assets/${n.id}`)).asset).toMatchObject({ name: "NicoCut_A", done: null });
    // the owner, given the share link of their own video, is still its owner
    expect((await tool(nicoKey, "review_update", { link: n.link, name: "Nico's cut" })).value).toMatchObject({ id: n.id, name: "Nico's cut" });
  });
});

describe("review_folders", () => {
  it("lists the account's own folders, makes one by name, and finds the one already called that", async () => {
    const made = (await tool(anaKey, "review_folders", { name: "Client work" })).value;
    expect(made).toEqual({ id: expect.any(String), name: "Client work", made: true });
    expect((await tool(anaKey, "review_folders", { name: " client WORK " })).value).toEqual({ id: made.id, name: "Client work", made: false });
    const listed = (await tool(anaKey, "review_folders")).value.folders as Array<{ id: string; name: string }>;
    expect(listed.filter((f) => f.name === "Client work")).toEqual([{ id: made.id, name: "Client work" }]);
    expect(listed.map((f) => f.name)).not.toContain("Nico's clients");
    expect(((await site(anaCookie, "/api/review/projects")) as Array<{ id: string }>).map((p) => p.id)).toContain(made.id);
  });
});

describe("review_trash", () => {
  it("an AI key from outside the app moves a video to the trash, lists the trash and brings the video back", async () => {
    const id = await video("ana", "TinyFlip_A.mp4");
    expect((await tool(anaKey, "review_trash", { link: `http://localhost/review/${id}` })).value).toEqual({ id, name: "TinyFlip_A", trashed: true });
    expect(await names(anaCookie)).not.toContain("TinyFlip_A");
    expect(await names(anaCookie, "/api/review/trash")).toContain("TinyFlip_A");
    expect((await tool(anaKey, "review_trash")).value.trash).toEqual(expect.arrayContaining([{ id, name: "TinyFlip_A", deleted: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/) }]));

    expect((await tool(anaKey, "review_trash", { link: id, restore: true })).value).toEqual({ id, name: "TinyFlip_A", restored: true, link: `http://localhost/review/${id}` });
    expect(await names(anaCookie)).toContain("TinyFlip_A");
    expect(await names(anaCookie, "/api/review/trash")).not.toContain("TinyFlip_A");
    // nothing to bring back twice, and never by a share link
    expect(await tool(anaKey, "review_trash", { link: id, restore: true })).toMatchObject({ error: true, text: "That video isn't in this account's trash: review_trash with no link lists what is." });
    expect((await tool(anaKey, "review_trash", { link: "http://localhost/r/00000000-0000-4000-8000-000000000000", restore: true })).text).toContain("Give the video's id or its /review/ link");
  });

  it("refuses someone else's video in plain words: a reviewer's link bins nothing", async () => {
    const n = await nicos();
    expect(await tool(anaKey, "review_trash", { link: n.link })).toMatchObject({ error: true, text: "That video is someone else's: only its owner can move it to the trash." });
    expect(await tool(anaKey, "review_trash", { link: n.id })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    expect(await tool(anaKey, "review_trash", { link: n.id, restore: true })).toMatchObject({ error: true });
    expect(await names(nicoCookie)).toContain("NicoCut_A");
  });

  it("the assistant asks first, naming the video: nothing moves until Yes, and No leaves it where it is", async () => {
    const keep = await video("ana", "TinyKeep_A.mp4");
    const bin = await video("ana", "TinyBin_A.mp4");
    const t = await turn("Bin the two tiny ones");
    const asked = await tool(t.token, "review_trash", { link: bin });
    expect(asked.error).toBe(false);
    expect(asked.text).toContain('Asked the user: "Move the Review video "TinyBin_A" to the trash?" Nothing has been changed.');
    await tool(t.token, "review_trash", { link: keep });
    // what is not hers is refused before any question is put
    const n = await nicos();
    expect((await tool(t.token, "review_trash", { link: n.link })).error).toBe(true);
    await t.end();
    expect(await names(anaCookie)).toEqual(expect.arrayContaining(["TinyKeep_A", "TinyBin_A"]));
    const reply = await lastReply();
    expect(reply.steps).toEqual(["Working in Review's trash"]);
    expect(reply.confirms!.map((q) => [q.question, q.status])).toEqual([
      ['Move the Review video "TinyBin_A" to the trash?', "waiting"],
      ['Move the Review video "TinyKeep_A" to the trash?', "waiting"],
    ]);

    const answer = (i: number, yes: boolean) => app.request(`/api/assistant/confirms/${reply.confirms![i]!.id}`, { method: "POST", ...json({ yes }, { cookie: anaCookie }) });
    expect((await answer(0, true)).status).toBe(200);
    expect((await answer(1, false)).status).toBe(200);
    expect((await lastReply()).confirms!.map((q) => q.status)).toEqual(["done", "no"]);
    expect(await names(anaCookie)).toContain("TinyKeep_A");
    expect(await names(anaCookie)).not.toContain("TinyBin_A");
    expect(await names(anaCookie, "/api/review/trash")).toContain("TinyBin_A");

    // bringing it back is asked of nobody
    const next = await turn("Bring it back");
    expect((await tool(next.token, "review_trash", { link: bin, restore: true })).value).toMatchObject({ id: bin, restored: true });
    await next.end();
    expect(await names(anaCookie)).toContain("TinyBin_A");
    expect((await lastReply()).confirms ?? []).toEqual([]);
  });
});

describe("in the dock", () => {
  it("each call shows its line under the reply, and a comment leaves the card that opens the video at it", async () => {
    const id = await video("ana", "TinyCard_A.mp4");
    const t = await turn("Tell the editor to trim the start");
    const cm = (await tool(t.token, "review_comment", { link: id, text: "Trim the start", at: 65 })).value;
    const reply = (await tool(t.token, "review_comment", { link: id, text: "And the end", reply_to: cm.id })).value;
    await tool(t.token, "review_folders");
    await tool(t.token, "review_update", { link: id, finished: true });
    const said = await lastReply();
    expect(said.steps).toEqual(["Writing a comment", "Looking at Review's folders", "Updating the video in Review"]);
    expect(said.work).toEqual([
      { id: `review:comment:${cm.id}`, kind: "review", title: "TinyCard_A", href: `/review/${id}?v=1&c=${cm.id}`, status: "done", detail: "Comment added at 1:05.00" },
      { id: `review:comment:${reply.id}`, kind: "review", title: "TinyCard_A", href: `/review/${id}?v=1&c=${cm.id}`, status: "done", detail: "Reply added" },
    ]);
    await t.end();
    // the assistant's comment is signed as the person it works for
    const stored = (await site(anaCookie, `/api/review/assets/${id}`)).comments as Array<Record<string, unknown>>;
    expect(stored.map((c) => [c.text, c.author, c.user, c.mine])).toEqual([["Trim the start", "ana", "ana", true], ["And the end", "ana", "ana", true]]);
  });

  it("an AI key from outside gets all four tools", async () => {
    const r = (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: anaKey }) })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(r.result.tools.map((x) => x.name)).toEqual(expect.arrayContaining(["review_comment", "review_update", "review_folders", "review_trash"]));
  });
});
