import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AssistantView } from "../../contracts/assistant";

// review_share in the assistant's dock: turning a share link on publishes the video, so it asks first (the Yes / No
// card), as the Media Library's share does. Turning one off, or handing back a link that is already on, asks nothing.
// An AI key from outside the app is not asked here: api/mcp.test.ts and review-links.test.ts drive it that way.

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-review-share-"));
process.env.APP_SECRET = "mcp-review-share-secret";

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { addVersion, reviewJobsDone } = await import("../review");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

const ana = createUser("ana", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookie = (await app.request("/api/auth/login", json({ username: "ana", password: "password1" }))).headers.get("set-cookie")!.split(";")[0]!;
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = ((await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization }))).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  const text = r.content[0]!.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.isError, text, value: (r.isError || !/^[[{]/.test(text) ? text : JSON.parse(text)) as any };
};
const reply = async () => ((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as AssistantView).messages.at(-1)!;
/** A turn of ana's with the Mac holding its job: the token to call tools as that reply, and how to end it. */
const turn = async (text: string) => {
  expect((await app.request("/api/assistant/turn", json({ text }, { cookie }))).status).toBe(202);
  const job = (await (await app.request("/api/devices/relay/wait", json({}, { authorization: `Bearer ${mac.token}` }))).json()) as { id: string; mcp: { token: string } };
  return {
    token: `Bearer ${job.mcp.token}`,
    end: async () => {
      await app.request(`/api/devices/relay/${job.id}/done`, json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }));
      await vi.waitFor(async () => expect((await reply()).status).toBe("done"));
    },
  };
};
const answer = (id: string, yes: boolean) => app.request(`/api/assistant/confirms/${id}`, json({ yes }, { cookie }));
/** The video's share as its owner's page reads it. */
const shareOf = async (id: string) => ((await (await app.request(`/api/review/assets/${id}`, { headers: { cookie } })).json()) as { asset: { share: { token: string; enabled: boolean; download: boolean } | null } }).asset.share;
const video = async (name: string) => {
  const added = await addVersion(undefined, { owner: "ana", name, mime: "video/mp4", bytes: 1 }, async () => {});
  await reviewJobsDone();
  return added!.meta.id;
};
const QUESTION = 'Turn on the share link of "TinyReel_A"? Anyone with the link can watch and comment, no account needed.';

describe("review_share in the assistant's dock", () => {
  it("turning a link on asks first, with the video's name: No leaves it off, Yes turns it on and hands the link over", async () => {
    const id = await video("TinyReel_A.mp4");
    const a = await turn("Give me a link to share that video");
    const asked = await tool(a.token, "review_share", { link: id });
    expect(asked.error).toBe(false);
    expect(asked.text).toContain(`Asked the user: "${QUESTION}" Nothing has been changed.`);
    await a.end();
    expect((await shareOf(id))?.enabled ?? false).toBe(false);
    let cards = (await reply()).confirms!;
    expect(cards.map((q) => [q.question, q.status])).toEqual([[QUESTION, "waiting"]]);

    expect((await answer(cards[0]!.id, false)).status).toBe(200);
    expect((await reply()).confirms!.map((q) => q.status)).toEqual(["no"]);
    expect((await shareOf(id))?.enabled ?? false).toBe(false);

    // asked again, with downloads: the question says so, and Yes turns it on
    const b = await turn("Yes, share it, and let them download it");
    expect((await tool(b.token, "review_share", { link: id, download: true })).text).toContain('Turn on the share link of "TinyReel_A"? Anyone with the link can watch, comment and download the file, no account needed.');
    await b.end();
    cards = (await reply()).confirms!;
    expect((await answer(cards[0]!.id, true)).status).toBe(200);
    const share = (await shareOf(id))!;
    expect(share).toMatchObject({ enabled: true, download: true });
    // the link reaches the person on the card they pressed
    const done = (await reply()).confirms![0]!;
    expect(done.status).toBe("done");
    expect(done.result).toContain(`http://localhost/r/${share.token}`);
    expect((await app.request(`/api/review/s/${share.token}`)).status).toBe(200);
  });

  it("a link that is already on is handed back, and one is turned off, without a question", async () => {
    const id = await video("TinyReel_B.mp4");
    expect((await app.request(`/api/review/assets/${id}`, { ...json({ share: { enabled: true } }, { cookie }), method: "PATCH" })).status).toBe(200);
    const { token } = (await shareOf(id))!;
    const t = await turn("What was that link again? Then turn it off");
    expect((await tool(t.token, "review_share", { link: id })).value).toMatchObject({ name: "TinyReel_B", share_link: `http://localhost/r/${token}`, download: false });
    expect((await tool(t.token, "review_share", { link: id, on: false })).value).toEqual({ name: "TinyReel_B", shared: false });
    await t.end();
    expect((await reply()).confirms).toBeUndefined();
    expect((await app.request(`/api/review/s/${token}`)).status).toBe(404);
    // off again is still not a question
    const again = await turn("Off, I said");
    expect((await tool(again.token, "review_share", { link: id, on: false })).value).toEqual({ name: "TinyReel_B", shared: false });
    await again.end();
    expect((await reply()).confirms).toBeUndefined();
  });

  it("an AI key from outside the app is not asked here: the link is on at once", async () => {
    const id = await video("TinyReel_C.mp4");
    const on = (await tool(anaKey, "review_share", { link: id })).value as { share_link: string };
    expect(on.share_link).toBe(`http://localhost/r/${(await shareOf(id))!.token}`);
    expect((await shareOf(id))!.enabled).toBe(true);
  });
});
