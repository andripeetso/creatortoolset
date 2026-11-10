import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(tmpdir(), "ig-share-"));
process.env.DATA_DIR = dataDir;

const { instagramApp } = await import("./instagram");

// No Apify key is set up, so every share is saved for later
// and nothing reaches the network.
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "sharer", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/", instagramApp);

const LATER = "for later: add your Apify key in Settings → API keys to crawl it";

type ShareBody = {
  message?: string;
  error?: string;
  posts: { id: string; shortcode: string }[];
  accounts: { username: string }[];
};

async function share(text: unknown, keep: { savedFor?: unknown; knowhow?: unknown } = {}) {
  const res = await app.request("/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...keep }),
  });
  return { status: res.status, body: (await res.json()) as ShareBody };
}

async function getJson<T>(url: string): Promise<T> {
  return (await (await app.request(url)).json()) as T;
}

const readPost = (id: string) =>
  JSON.parse(readFileSync(path.join(dataDir, "instagram", id, "meta.json"), "utf-8")) as {
    savedFor?: string[];
    knowhow?: boolean;
  };

const listedIds = async (query = "") =>
  (await getJson<{ id: string }[]>(`/${query}`)).map((p) => p.id);

const postDirs = () =>
  readdirSync(path.join(dataDir, "instagram")).filter(
    (d) => existsSync(path.join(dataDir, "instagram", d, "meta.json")),
  );

describe("POST /share", () => {
  it("saves a post link found inside shared caption text", async () => {
    const { status, body } = await share(
      "Look at this one https://www.instagram.com/reel/SHAREabc123/?igsh=MWx0dTN4 so good",
    );
    expect(status).toBe(200);
    expect(body.message).toBe(`Saved to Content ${LATER}`);
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].shortcode).toBe("SHAREabc123");
    const meta = JSON.parse(
      readFileSync(path.join(dataDir, "instagram", body.posts[0].id, "meta.json"), "utf-8"),
    );
    expect(meta.owner).toBe("sharer");
    expect(meta.status).toBe("ready");
    expect(meta.url).toBe("https://www.instagram.com/reel/SHAREabc123/");
  });

  it("says a post shared twice is already in the library", async () => {
    const before = postDirs().length;
    const { status, body } = await share("https://instagram.com/reel/SHAREabc123");
    expect(status).toBe(200);
    expect(body.message).toBe("Already in your library");
    expect(postDirs()).toHaveLength(before);
  });

  it("adds the account for a shared profile link, once", async () => {
    const first = await share("https://www.instagram.com/some.creator?igsh=abc123");
    expect(first.status).toBe(200);
    expect(first.body.message).toBe(`Added @some.creator ${LATER}`);
    expect(first.body.accounts[0].username).toBe("some.creator");
    const again = await share("https://www.instagram.com/some.creator/");
    expect(again.body.message).toBe("@some.creator is already in your library");
  });

  it("refuses text without an Instagram link", async () => {
    for (const text of ["https://www.tiktok.com/@x/video/123", "just words", "", 42]) {
      const { status, body } = await share(text);
      expect(status).toBe(400);
      expect(body.error).toBe("No Instagram link in what you shared");
    }
  });
});

describe("Kept for: Content, Format or Know-how", () => {
  it("marks a Format share", async () => {
    const { body } = await share("https://www.instagram.com/p/FORMATpost1/", { savedFor: "format" });
    expect(body.message).toBe(`Saved to Format ${LATER}`);
    expect(readPost(body.posts[0].id).savedFor).toEqual(["format"]);
  });

  it("keeps a Know-how share off the library, search and ideas lists", async () => {
    const { body } = await share("https://www.instagram.com/reel/KNOWhow1/", { knowhow: true });
    expect(body.message).toBe(`Saved to Know-how ${LATER}`);
    const id = body.posts[0].id;
    expect(readPost(id).knowhow).toBe(true);
    expect(await listedIds()).not.toContain(id);
    expect(await listedIds("?shelf=knowhow")).toEqual([id]);
    expect(await listedIds("?shelf=all")).toContain(id);
    const found = await getJson<{ post?: { id: string }; id?: string }[]>("/find?q=KNOWhow1");
    expect(JSON.stringify(found)).not.toContain(id);
  });

  it("moves a post when it is shared again with another choice", async () => {
    const first = await share("https://www.instagram.com/p/MOVEme1/", { savedFor: "format" });
    const id = first.body.posts[0].id;
    const again = await share("https://www.instagram.com/p/MOVEme1/", { knowhow: true });
    expect(again.body.message).toBe("Already in your library, moved to Know-how");
    expect(readPost(id).knowhow).toBe(true);
    const same = await share("https://www.instagram.com/p/MOVEme1/", { knowhow: true });
    expect(same.body.message).toBe("Already in your library");
  });

  it("brings a Know-how post back when it is kept for content", async () => {
    const { body } = await share("https://www.instagram.com/reel/BACKagain1/", { knowhow: true });
    const id = body.posts[0].id;
    const res = await app.request(`/${id}/research`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ savedFor: ["content"] }),
    });
    expect(res.status).toBe(200);
    expect(readPost(id).knowhow).toBeUndefined();
    expect(await listedIds()).toContain(id);
    await app.request(`/${id}/research`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowhow: true }),
    });
    expect(await listedIds()).not.toContain(id);
  });

  it("saves Know-how from a paste too, and refuses a bad choice", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.instagram.com/reel/PASTEknow1/", run: "later", knowhow: true }),
    });
    const { posts } = (await res.json()) as { posts: { id: string }[] };
    expect(readPost(posts[0].id).knowhow).toBe(true);
    const bad = await share("https://www.instagram.com/reel/BADchoice1/", { knowhow: "yes" });
    expect(bad.status).toBe(400);
  });
});

describe("POST /accounts after the share refactor", () => {
  it("still adds an account for later, and refuses junk", async () => {
    const ok = await app.request("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "@another.creator", run: "later" }),
    });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { username: string }).username).toBe("another.creator");

    const now = await app.request("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "@third.creator", run: "now" }),
    });
    expect(now.status).toBe(409);
    expect(((await now.json()) as { code: string }).code).toBe("NO_APIFY");

    const bad = await app.request("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/nope" }),
    });
    expect(bad.status).toBe(400);
  });
});
