import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Goes with mcp-review.patch (the orchestrator's api/mcp.ts): the old Review tools on a reviewer's link, the folder in
// list_reviews, the download link in get_review. It fails without that patch.

const dataDir = mkdtempSync(path.join(tmpdir(), "mcp-review-links-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "mcp-review-links-secret";

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { addVersion, reviewJobsDone } = await import("../review");

const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", ...json({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const nicoCookie = await cookieOf("nico");
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
const video = async (owner: string, name: string, place: (dest: string) => Promise<void> = async () => {}) => {
  const added = await addVersion(undefined, { owner, name, mime: "video/mp4", bytes: 1 }, place);
  await reviewJobsDone();
  return added!.meta.id;
};

describe("the old Review tools on a reviewer's link", () => {
  it("resolve what you wrote, approve or ask for changes; the rest is the owner's, said in plain words", async () => {
    const id = await video("nico", "NicoCut_A.mp4");
    const token = (await site(nicoCookie, `/api/review/assets/${id}`, "PATCH", { share: { enabled: true } })).share.token as string;
    const link = `http://localhost/r/${token}`;
    const hers = (await tool(anaKey, "review_comment", { link, text: "Trim the start" })).value;
    const his = (await tool(nicoKey, "review_comment", { link: id, text: "Note to self" })).value;

    expect((await tool(anaKey, "resolve_comment", { link, comment_id: hers.id })).value).toEqual({ id: hers.id, resolved: true, text: "Trim the start" });
    expect(await tool(anaKey, "resolve_comment", { link, comment_id: his.id })).toMatchObject({ error: true, text: "That video is someone else's: on its share link you can resolve only the comments you wrote." });
    expect(await tool(anaKey, "resolve_comment", { link, comment_id: "nope" })).toMatchObject({ error: true, text: "No comment with that id on this video: get_review lists them." });

    expect((await tool(anaKey, "review_set_approval", { link, status: "changes" })).value).toEqual({ id, name: "NicoCut_A", approval: "changes" });
    expect(await tool(anaKey, "review_set_approval", { link, status: "in_progress" })).toMatchObject({ error: true, text: expect.stringContaining("That video is someone else's: on its share link you can approve it or ask for changes") });
    expect(await tool(anaKey, "review_share", { link, on: false })).toMatchObject({ error: true, text: "That video is someone else's: only its owner can change its share link." });

    const seen = await site(nicoCookie, `/api/review/assets/${id}`);
    expect(seen.asset.approval).toMatchObject({ status: "changes", by: "ana" });
    expect(seen.asset.share.enabled).toBe(true);
    expect((seen.comments as Array<Record<string, unknown>>).map((c) => [c.text, !!c.resolved])).toEqual([["Trim the start", true], ["Note to self", false]]);
    expect(((await site(nicoCookie, "/api/review/notifications")).items as Array<Record<string, unknown>>).map((x) => [x.kind, x.by])).toEqual([["changes", "ana"], ["comment", "ana"]]);

    // the owner, given the share link of their own video, keeps every right (as before the change)
    expect((await tool(nicoKey, "resolve_comment", { link, comment_id: hers.id, resolved: false })).value.resolved).toBe(false);
    expect((await tool(nicoKey, "review_set_approval", { link, status: "in_progress" })).value.approval).toBe("in_progress");
    expect((await tool(nicoKey, "review_share", { link, on: false })).value).toMatchObject({ shared: false });
    expect(await tool(anaKey, "review_set_approval", { link, status: "approved" })).toMatchObject({ error: true, text: "Not found, or not this account's." });
  });

  it("works the same on a shared folder's video", async () => {
    const folder = await site(nicoCookie, "/api/review/projects", "POST", { name: "Nico's clients" });
    const id = await video("nico", "NicoCut_B.mp4");
    await site(nicoCookie, `/api/review/assets/${id}`, "PATCH", { projectId: folder.id });
    const ptoken = (await site(nicoCookie, `/api/review/projects/${folder.id}`, "PATCH", { share: { enabled: true } })).share.token as string;
    const link = `http://localhost/rp/${ptoken}/${id}`;
    expect((await tool(anaKey, "review_set_approval", { link, status: "approved" })).value.approval).toBe("approved");
    expect((await tool(anaKey, "review_share", { link })).error).toBe(true);
  });
});

describe("list_reviews", () => {
  it("names the folder a video is filed in", async () => {
    const id = await video("ana", "TinyReel_A.mp4");
    await video("ana", "TinyLoose_A.mp4");
    await tool(anaKey, "review_folders", { name: "Tiny Acrobatics" });
    await tool(anaKey, "review_update", { link: id, folder: "Tiny Acrobatics" });
    const listed = (await tool(anaKey, "list_reviews")).value.reviews as Array<Record<string, unknown>>;
    expect(listed.find((r) => r.name === "TinyReel_A")).toMatchObject({ id, folder: "Tiny Acrobatics" });
    expect(listed.find((r) => r.name === "TinyLoose_A")).not.toHaveProperty("folder");
    // the name it gives is the one review_update takes
    expect((await tool(anaKey, "review_update", { link: id, folder: String(listed.find((r) => r.id === id)!.folder) })).error).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("get_review", () => {
  it("hands back a download link per version where the caller may have the file: the owner's needs their sign-in, a share link's opens for anyone while downloads are on", async () => {
    const clip = path.join(dataDir, "tiny.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", clip]);
    const id = await video("ana", "TinyReel_B.mp4", async (dest) => copyFileSync(clip, dest));
    const anaCookie = await cookieOf("ana");
    const versionsOf = async (key: string, link: string) => (JSON.parse((await tool(key, "get_review", { link, frames: 0 })).text) as { versions: Array<{ status: string; download?: string }> }).versions;

    const [mine] = await versionsOf(anaKey, id);
    expect(mine).toMatchObject({ status: "ready", download: `http://localhost/api/review/assets/${id}/v/1/download` });
    const route = new URL(mine!.download!).pathname;
    const got = await app.request(route, { headers: { cookie: anaCookie } });
    expect([got.status, got.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="TinyReel_B.mp4"']);
    expect((await app.request(route)).status).toBe(401);

    // a reviewer's link: no download while the owner keeps downloads off, the link's own route once they are on
    const share = (await tool(anaKey, "review_share", { link: id })).value.share_link as string;
    expect((await versionsOf(nicoKey, share))[0]).not.toHaveProperty("download");
    await tool(anaKey, "review_share", { link: id, download: true });
    const [theirs] = await versionsOf(nicoKey, share);
    expect(theirs!.download).toBe(`http://localhost/api/review/s/${share.split("/r/")[1]}/v/1/download`);
    expect((await app.request(new URL(theirs!.download!).pathname)).status).toBe(200);
  });
});
