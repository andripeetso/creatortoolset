import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "ws-share-"));
process.env.DATA_DIR = dataDir;
const { Hono } = await import("hono");
const { workshopApp, workshopShareApp } = await import("./workshop");

const session = "aaaaaaaa-0000-4000-8000-000000000001";
const sdir = path.join(dataDir, "workshop", "sessions", session);
mkdirSync(path.join(sdir, "docs"), { recursive: true });
writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id: session, owner: "alex", title: "Strength training", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
const doc = (id: string, kind: string, title: string, blocks: string[], extra = {}) =>
  writeFileSync(
    path.join(sdir, "docs", `${id}.json`),
    JSON.stringify({ id, sessionId: session, kind, title, frameworkIds: [], versions: [], nextBlock: blocks.length + 1, nextVersion: 1, createdAt: 1, updatedAt: 2, blocks: blocks.map((text, i) => ({ id: `b${i + 1}`, text, author: "user", at: 1 })), ...extra }),
  );
doc("cccccccc-0000-4000-8000-000000000001", "carousel", "Carousel", ["This is why your sample needs a **clear plan**", "(BUT) Before…"], { caption: { text: "Saved for later.", author: "user", at: 1 } });
doc("cccccccc-0000-4000-8000-000000000002", "reel", "Reel script", ["So our sample has its own plan."]);
doc("cccccccc-0000-4000-8000-000000000003", "notes", "Notes", ["private scraps"]);

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
app.route("/api/workshop-share", workshopShareApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe("Workshop share links", () => {
  it("makes one link for a batch, shows the pieces live without notes, and stops", async () => {
    const made = await call("POST", `/api/workshop/sessions/${session}/shares`, {
      docIds: ["cccccccc-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000002", "cccccccc-0000-4000-8000-000000000003", "not-mine"],
    });
    expect(made.status).toBe(200);
    const link = (await made.json()) as { token: string; docIds: string[]; title: string };
    expect(link.docIds).toEqual(["cccccccc-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000002"]);
    expect(link.title).toBe("Strength training");

    const listed = (await (await call("GET", `/api/workshop/sessions/${session}/shares`)).json()) as { shares: Array<{ token: string }> };
    expect(listed.shares.map((s) => s.token)).toEqual([link.token]);

    const open = await call("GET", `/api/workshop-share/${link.token}`);
    const view = (await open.json()) as { title: string; pieces: Array<{ kind: string; blocks: Array<{ text: string }>; caption: string }> };
    expect(view.pieces.map((p) => p.kind)).toEqual(["carousel", "reel"]);
    expect(view.pieces[0]!.blocks[0]!.text).toContain("**clear plan**");
    expect(view.pieces[0]!.caption).toBe("Saved for later.");
    expect(JSON.stringify(view)).not.toContain("private scraps");

    expect((await call("DELETE", `/api/workshop/sessions/${session}/shares/${link.token}`)).status).toBe(200);
    expect((await call("GET", `/api/workshop-share/${link.token}`)).status).toBe(404);
  });

  it("refuses an empty batch", async () => {
    expect((await call("POST", `/api/workshop/sessions/${session}/shares`, { docIds: [] })).status).toBe(400);
  });
});

describe("the whole project, like Frame.io", () => {
  it("is one link with every piece, the freelancer marks it and uploads the final", async () => {
    const made = (await (await call("POST", `/api/workshop/sessions/${session}/shares`, { all: true })).json()) as { token: string; all: boolean };
    expect(made.all).toBe(true);
    const again = (await (await call("POST", `/api/workshop/sessions/${session}/shares`, { all: true })).json()) as { token: string };
    expect(again.token).toBe(made.token); // the same link every time

    const view = (await (await call("GET", `/api/workshop-share/${made.token}`)).json()) as { title: string; status: string; pieces: Array<{ kind: string }>; deliveries: unknown[] };
    expect(view.title).toBe("Strength training");
    expect(view.pieces.map((p) => p.kind)).toEqual(["carousel", "reel"]);
    expect(view.deliveries).toEqual([]);

    const producing = await call("POST", `/api/workshop-share/${made.token}/progress`, { state: "producing", by: "Ada" });
    expect(((await producing.json()) as { progress: { state: string; by: string } }).progress).toMatchObject({ state: "producing", by: "Ada" });
    expect(((await (await call("GET", `/api/workshop-share/${made.token}`)).json()) as { status: string }).status).toBe("editing");

    const file = new TextEncoder().encode("slide-1.png bytes");
    const up = await app.request(`/api/workshop-share/${made.token}/deliveries?name=slide-1.png&by=Ada&note=final`, { method: "POST", headers: { "Content-Type": "image/png", "Content-Length": String(file.length) }, body: file });
    expect(up.status).toBe(200);
    const item = (await up.json()) as { id: string; name: string; size: number; by: string };
    expect(item).toMatchObject({ name: "slide-1.png", size: file.length, by: "Ada" });
    const down = await call("GET", `/api/workshop-share/${made.token}/deliveries/${item.id}?download=1`);
    expect(await down.text()).toBe("slide-1.png bytes");
    expect(down.headers.get("content-disposition")).toContain("slide-1.png");

    await call("POST", `/api/workshop-share/${made.token}/progress`, { state: "done", by: "Ada" });
    const done = (await (await call("GET", `/api/workshop-share/${made.token}`)).json()) as { status: string; progress: { state: string }; deliveries: Array<{ name: string }> };
    expect(done.status).toBe("toPost");
    expect(done.progress.state).toBe("done");
    expect(done.deliveries.map((d) => d.name)).toEqual(["slide-1.png"]);

    expect((await call("POST", `/api/workshop-share/00000000-0000-4000-8000-000000000000/progress`, { state: "done" })).status).toBe(404);
  });
});

describe("answering comments on the share link", () => {
  it("is there for someone who can open the session, and nobody else", async () => {
    const { token } = (await (await call("POST", `/api/workshop/sessions/${session}/shares`, { all: true })).json()) as { token: string };
    const got = (await (await call("GET", `/api/workshop-share/${token}/answers`)).json()) as { post: unknown; comments: unknown[]; thread: unknown[] };
    expect(got).toMatchObject({ post: null, comments: [], thread: [] });

    const as = (user: unknown) => {
      const other = new Hono<{ Variables: { user: unknown } }>();
      other.use("*", async (c, next) => (c.set("user", user), next()));
      other.route("/api/workshop-share", workshopShareApp as never);
      return other;
    };
    const stranger = as({ username: "ada", role: "user", cloud: true, off: [] });
    expect((await stranger.request(`/api/workshop-share/${token}/answers`)).status).toBe(404);
    expect((await stranger.request(`/api/workshop-share/${token}/answers/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "hi" }) })).status).toBe(404);
    expect((await as(undefined).request(`/api/workshop-share/${token}/answers`)).status).toBe(404);
    // the link itself stays public
    expect((await stranger.request(`/api/workshop-share/${token}`)).status).toBe(200);
  });
});

describe("comments on a session with several posts", () => {
  it("the share's answers name every post the session became, the first one as the Open post link", async () => {
    const { token } = (await (await call("POST", `/api/workshop/sessions/${session}/shares`, { all: true })).json()) as { token: string };
    const postings = [
      { shortcode: "DfdJozjPjT2", url: "https://www.instagram.com/p/DfdJozjPjT2/", by: "you", at: 1, version: "2294" },
      { shortcode: "DfdJu8-v6tq", url: "https://www.instagram.com/p/DfdJu8-v6tq/", by: "you", at: 2, version: "2296" },
    ];
    const meta = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(sdir, "meta.json"), "utf8"));
    writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ ...meta, postings, posted: postings[0] }));
    try {
      const got = (await (await call("GET", `/api/workshop-share/${token}/answers`)).json()) as { post: { shortcode: string }; posts: Array<{ shortcode: string }> };
      expect(got.posts.map((p) => p.shortcode)).toEqual(["DfdJozjPjT2", "DfdJu8-v6tq"]);
      expect(got.post.shortcode).toBe("DfdJozjPjT2");
    } finally {
      writeFileSync(path.join(sdir, "meta.json"), JSON.stringify(meta));
    }
  });
});
