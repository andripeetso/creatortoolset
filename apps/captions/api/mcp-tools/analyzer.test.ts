import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "mcp-analyzer-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "mcp-analyzer-secret";

// A save reads the post through Apify. Here that request is held open and never answered by the internet: the post
// stays "being read" for as long as the tests look at it.
const asked: string[] = [];
let release = () => {};
const held = new Promise<void>((r) => (release = r));
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown) => {
    asked.push(input instanceof Request ? input.url : String(input));
    await held;
    return new Response("{}", { status: 500 });
  }),
);
afterAll(() => release());

const ig = (...p: string[]) => path.join(dataDir, "instagram", ...p);
const slide = (index: number, extra: Record<string, unknown> = {}) => ({
  index, kind: "image", file: `media/0${index}.jpg`, mime: "image/jpeg", width: 10, height: 10, bytes: 0, transcript: { status: "skipped" }, vision: { status: "skipped" }, ...extra,
});
const DONE = ["info", "stats", "media", "transcript", "vision"].map((type) => ({ type, status: "done" }));

/** A post in the library, as the Analyzer keeps it: meta.json, and the words said on its first slide. */
function post(code: string, extra: Record<string, unknown> = {}, said = ""): string {
  const id = randomUUID();
  const url = `https://www.instagram.com/reel/${code}/`;
  mkdirSync(ig(id, "transcripts"), { recursive: true });
  writeFileSync(
    ig(id, "meta.json"),
    JSON.stringify({
      id, owner: "ana", status: "ready", progress: 1, input: url, url, shortcode: code, mediaId: "1", kind: "reel",
      creator: { id: "1", username: "tinyacrobatics" }, takenAt: Date.UTC(2026, 9, 1, 9, 30), pulledAt: Date.UTC(2026, 9, 2), caption: "",
      counts: { plays: 1200, likes: 80, comments: 4, fetchedAt: 1 }, comments: { status: "skipped", count: 0, replies: 0 },
      bytes: 0, createdAt: 1, updatedAt: 1, recipe: { preset: "watch", jobs: DONE.map((j) => j.type) }, jobs: DONE, tags: [],
      slides: [slide(0, { kind: "video", durationS: 31.4, transcript: { status: said ? "done" : "skipped" } })],
      ...extra,
    }),
  );
  if (said) writeFileSync(ig(id, "transcripts", "00.json"), JSON.stringify({ words: said.split(" ").map((text, i) => ({ text, start: i, end: i + 1 })) }));
  return id;
}

const DESCRIPTION = `Forward rolls before breakfast.\n\n${"Soft mat, chin tucked, hands by the ears. ".repeat(12)}Save it for tomorrow morning.`;
const roll = post(
  "TinyRoll1",
  {
    caption: DESCRIPTION,
    idea: { title: "A morning roll routine", takeaway: "Three rolls a day make a tumbler." },
    slides: [slide(0, { kind: "video", durationS: 31.4, transcript: { status: "done" }, vision: { status: "done", onScreenText: "3 moves before breakfast", textKind: "text" } })],
  },
  "Start with a forward roll on a soft mat",
);
const carousel = post("TinyCar01", {
  kind: "carousel",
  url: "https://www.instagram.com/p/TinyCar01/",
  caption: "Five ways to make balance practice fun",
  takenAt: Date.UTC(2026, 9, 20),
  counts: { likes: 310, comments: 12, fetchedAt: 1 },
  slides: [slide(0, { vision: { status: "done", onScreenText: "Walk the tape line", textKind: "text" } }), slide(1, { vision: { status: "done", onScreenText: "Balance on one foot", textKind: "text" } })],
});
// another creator's reel, its text on screen only the subtitles of what is said
const tumblers = post(
  "TinyTumb1",
  {
    creator: { id: "2", username: "tinytumblers" },
    caption: "Cartwheel drill for small gyms",
    slides: [slide(0, { kind: "video", transcript: { status: "done" }, vision: { status: "done", onScreenText: "Hands down, kick over the line", textKind: "captions" } })],
  },
  "Hands down, kick over the line",
);
// shared from a phone with no key set up: saved for later, a share link that has no shortcode until it is read
const shared = post("", {
  input: "https://www.instagram.com/share/TinyShare9?igsh=abc",
  url: "https://www.instagram.com/share/TinyShare9",
  creator: { id: "", username: "" },
  takenAt: 0,
  counts: { fetchedAt: 0 },
  slides: [],
  jobs: DONE.map((j) => ({ ...j, status: "pending" })),
});
const video = post(
  "yt-TinyVid0001",
  { platform: "youtube", kind: "post", url: "https://www.youtube.com/watch?v=TinyVid0001", caption: "A whole class, start to finish" },
  "cartwheel ".repeat(3000).trim(),
);
// saved from a phone's share link and read since: the read put the post's own shortcode and link in place of the shared ones
const resolved = post("TinyReal22", { input: "https://www.instagram.com/share/reel/TinyShr22/?igsh=1", caption: "Shared, then read" });
const failed = post("TinyGone1", { status: "error", error: "This post is private or was deleted", jobs: [{ type: "info", status: "error", error: "This post is private or was deleted" }], slides: [] });
const nicos = post("TinyNico1", { owner: "nico", caption: "Nico's own saved roll" });

const account = randomUUID();
mkdirSync(ig("accounts", account), { recursive: true });
writeFileSync(ig("accounts", account, "meta.json"), JSON.stringify({ id: account, igUserId: "2", username: "tinytumblers", owner: "ana", tags: [], counts: { fetchedAt: 0 }, status: "ready", progress: 1, createdAt: 1, updatedAt: 1 }));
// ana has her own Apify key; nico has none
mkdirSync(ig("users", "ana"), { recursive: true });
writeFileSync(ig("users", "ana", "apify.json"), JSON.stringify({ token: "test-token", savedAt: 1, savedBy: "ana", valid: true, source: "file" }));

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
import type { AssistantView } from "../../contracts/assistant";

const ana = createUser("ana", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(createUser("nico", "password1"), "full")}`;

const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const rpc = async (authorization: string, method: string, params: unknown = {}) =>
  (await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method, params }, { authorization }))).json()) as {
    result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean };
  };
/** One tool call: its answer, or the words it refused with. */
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await rpc(authorization, "tools/call", { name, arguments: args })).result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.isError, value: (r.isError ? r.content![0]!.text : JSON.parse(r.content![0]!.text)) as any };
};
const NOT_SAVED = { error: true, value: "That post is not in the library: instagram_save saves it by its link." };

describe("the Analyzer's tools", () => {
  it("are listed for any AI key", async () => {
    expect((await rpc(anaKey, "tools/list")).result.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["instagram_post", "instagram_search", "instagram_save"]));
  });
});

describe("instagram_post", () => {
  it("reads a saved post: who, when, counts, the whole post description, the idea, what is said and the text on screen", async () => {
    const out = await tool(anaKey, "instagram_post", { post: roll });
    expect(out.value).toEqual({
      id: roll,
      link: "https://www.instagram.com/reel/TinyRoll1/",
      creator: "@tinyacrobatics",
      kind: "reel",
      posted: "2026-10-01 09:30",
      plays: 1200,
      likes: 80,
      comments: 4,
      state: "ready",
      app_link: `http://localhost/instagram/${roll}`,
      description: DESCRIPTION,
      idea: { title: "A morning roll routine", takeaway: "Three rolls a day make a tumbler." },
      slides: [{ slide: 1, kind: "video", seconds: 31, said: "Start with a forward roll on a soft mat", on_screen: "3 moves before breakfast" }],
    });
    expect(DESCRIPTION.length).toBeGreaterThan(500);
  });

  it("finds the post by its link, its shortcode or the app's own link", async () => {
    for (const given of ["https://www.instagram.com/tinyacrobatics/reel/TinyRoll1/?igsh=abc", "instagram.com/p/TinyRoll1", "TinyRoll1", `http://localhost/instagram/${roll}`, `/analyzer/${roll}?from=chat`]) {
      expect((await tool(anaKey, "instagram_post", { post: given })).value.id, given).toBe(roll);
    }
    expect((await tool(anaKey, "instagram_post", { post: "https://youtu.be/TinyVid0001" })).value.id).toBe(video);
    expect((await tool(anaKey, "instagram_post", { post: "TinyVid0001" })).value).toMatchObject({ id: video, platform: "youtube", kind: "post" });
    // a share link whose post has been read since is still found by that link, and by the post's own
    expect((await tool(anaKey, "instagram_post", { post: "https://instagram.com/share/reel/TinyShr22" })).value.id).toBe(resolved);
    expect((await tool(anaKey, "instagram_post", { post: "https://www.instagram.com/reel/TinyReal22/" })).value.id).toBe(resolved);
  });

  it("a carousel has each slide's text; subtitles of what is said are not repeated", async () => {
    expect((await tool(anaKey, "instagram_post", { post: carousel })).value.slides).toEqual([
      { slide: 1, kind: "image", on_screen: "Walk the tape line" },
      { slide: 2, kind: "image", on_screen: "Balance on one foot" },
    ]);
    expect((await tool(anaKey, "instagram_post", { post: tumblers })).value.slides).toEqual([{ slide: 1, kind: "video", said: "Hands down, kick over the line", subtitles: true }]);
  });

  it("cuts a long transcript and says so", async () => {
    const out = (await tool(anaKey, "instagram_post", { post: video })).value;
    expect(out.slides[0].said).toHaveLength(20_000);
    expect(out.cut).toEqual(["said, slide 1: the first 20000 of 29999 characters"]);
    expect((await tool(anaKey, "instagram_post", { post: roll })).value.cut).toBeUndefined();
  });

  it("says where a post stands: saved for later, or failed with the reason", async () => {
    const later = (await tool(anaKey, "instagram_post", { post: "https://www.instagram.com/share/TinyShare9/?igsh=xyz" })).value;
    expect(later).toMatchObject({ id: shared, state: "not read yet", description: "", slides: [] });
    expect(later.note).toContain("instagram_save");
    expect(later.creator).toBeUndefined();
    expect((await tool(anaKey, "instagram_post", { post: failed })).value).toMatchObject({ state: "failed", error: "This post is private or was deleted", problems: ["info: This post is private or was deleted"] });
  });

  it("a post that is not saved, or someone else's, is refused in words the AI can act on", async () => {
    expect(await tool(anaKey, "instagram_post", { post: "https://www.instagram.com/reel/TinyNope1/" })).toEqual(NOT_SAVED);
    expect(await tool(anaKey, "instagram_post", { post: "TinyNope1" })).toEqual(NOT_SAVED);
    expect(await tool(anaKey, "instagram_post", { post: "https://www.instagram.com/share/TinyNope9/" })).toEqual(NOT_SAVED);
    expect(await tool(anaKey, "instagram_post", { post: "https://www.youtube.com/watch?v=TinyNope001" })).toEqual(NOT_SAVED);
    // nico's post: not in ana's list, and not hers to open by id
    expect(await tool(anaKey, "instagram_post", { post: "TinyNico1" })).toEqual(NOT_SAVED);
    expect(await tool(anaKey, "instagram_post", { post: nicos })).toEqual({ error: true, value: "Not found, or not this account's." });
    expect((await tool(nicoKey, "instagram_post", { post: nicos })).value.description).toBe("Nico's own saved roll");
    expect((await tool(anaKey, "instagram_post", { post: "@tinyacrobatics" })).value).toBe("That is an account, not a post: instagram_posts lists @tinyacrobatics's posts.");
    expect((await tool(anaKey, "instagram_post", { post: "https://example.com/a/b" })).value).toBe('"https://example.com/a/b" is not a post\'s library id, link or shortcode.');
    expect((await tool(anaKey, "instagram_post")).error).toBe(true);
  });
});

describe("instagram_search", () => {
  it("finds saved posts by words, each with the id instagram_post reads and a short piece of the post description", async () => {
    const out = (await tool(anaKey, "instagram_search", { q: "forward roll" })).value;
    expect(out.posts[0]).toEqual({
      id: roll,
      link: "https://www.instagram.com/reel/TinyRoll1/",
      creator: "@tinyacrobatics",
      kind: "reel",
      posted: "2026-10-01 09:30",
      plays: 1200,
      likes: 80,
      comments: 4,
      idea: "A morning roll routine",
      description: `${DESCRIPTION.replace(/\s+/g, " ").slice(0, 200)}…`,
    });
    // words on a slide and words that are only said are found too, the post with more of them first; someone else's posts never are
    expect((await tool(anaKey, "instagram_search", { q: "tape line" })).value.posts.map((p: { id: string }) => p.id)).toEqual([carousel, tumblers]);
    expect((await tool(anaKey, "instagram_search", { q: "kick" })).value.posts.map((p: { id: string }) => p.id)).toEqual([tumblers]);
    expect((await tool(anaKey, "instagram_search", { q: "Nico" })).value.posts).toEqual([]);
  });

  it("narrows to a kind or an account, and passes on the route's own refusal", async () => {
    const ids = async (args: Record<string, unknown>) => (await tool(anaKey, "instagram_search", args)).value.posts.map((p: { id: string }) => p.id);
    expect((await ids({ q: "cartwheel roll balance" })).sort()).toEqual([carousel, roll, tumblers, video].sort());
    expect(await ids({ q: "cartwheel roll balance", kind: "carousel" })).toEqual([carousel]);
    expect(await ids({ q: "cartwheel roll balance", account: "@TinyTumblers" })).toEqual([tumblers]);
    expect(await ids({ q: "cartwheel roll balance", limit: 1 })).toHaveLength(1);
    expect(await tool(anaKey, "instagram_search", { q: "roll", account: "nobody" })).toEqual({ error: true, value: "No account of yours is called @nobody: instagram_add_account adds it." });
    expect(await tool(anaKey, "instagram_search", { q: "r" })).toEqual({ error: true, value: "Type at least two characters" });
  });

  it("searches the project the person is in, as the page does", async () => {
    const cookie = (await app.request("/api/auth/login", json({ username: "ana", password: "password1" }))).headers.get("set-cookie")!.split(";")[0]!;
    const project = async (name: string) => ((await (await app.request("/api/workshop/projects", json({ name }, { cookie }))).json()) as { id: string }).id;
    const acrobatics = await project("Tiny Acrobatics");
    const homes = await project("Tiny Homes");
    const shelf = post("TinyHome1", { projectId: homes, creator: { id: "3", username: "tinyhomes" }, caption: "A plywood bookshelf in an afternoon" });
    const ids = async () => (await tool(anaKey, "instagram_search", { q: "plywood bookshelf" })).value.posts.map((p: { id: string }) => p.id);
    // the newest project is the one she is in
    expect(await ids()).toEqual([shelf]);
    await app.request("/api/workshop/workspace", { ...json({ currentProjectId: acrobatics }, { cookie }), method: "PATCH" });
    expect(await ids()).toEqual([]);
    // one post she names is read wherever it is kept
    expect((await tool(anaKey, "instagram_post", { post: "TinyHome1" })).value.id).toBe(shelf);
  });
});

describe("instagram_save", () => {
  it("without an Apify key the route's own words come back", async () => {
    expect(await tool(nicoKey, "instagram_save", { links: ["https://www.instagram.com/reel/TinyNew01/"] })).toEqual({
      error: true,
      value: "Reading other creators' posts needs your own Apify key: add it in Settings → API keys",
    });
    expect(await tool(anaKey, "instagram_save", { links: ["not a link"] })).toEqual({ error: true, value: "Paste a link to an Instagram post, reel or carousel, or a YouTube video or Short" });
    expect((await tool(anaKey, "instagram_save")).error).toBe(true);
  });

  it("saves posts by their links and answers each one's library id and state; instagram_post then shows it being read", async () => {
    const out = (await tool(anaKey, "instagram_save", { links: ["https://www.instagram.com/reel/TinyNew01/?igsh=abc", "https://www.instagram.com/reel/TinyRoll1/"], read: "full" })).value;
    expect(out.saved).toHaveLength(2);
    const [fresh, had] = out.saved;
    expect(fresh).toEqual({ id: fresh.id, link: "https://www.instagram.com/reel/TinyNew01/", state: "reading", app_link: `http://localhost/instagram/${fresh.id}` });
    // already in the library: no second copy, and the parts it lacks (full adds the comments and tags) are read
    expect(had).toMatchObject({ id: roll, already: true });
    expect(out.note).toContain("instagram_post");
    const reading = (await tool(anaKey, "instagram_post", { post: fresh.id })).value;
    expect(reading).toMatchObject({ id: fresh.id, state: "reading", description: "", slides: [] });
    expect(reading.note).toBe("Still being read: call instagram_post again in a minute.");
    // one link as a plain string is taken too; it is the same post
    expect((await tool(anaKey, "instagram_save", { links: "instagram.com/reel/TinyNew01" })).value.saved).toMatchObject([{ id: fresh.id, already: true }]);
    // nothing went anywhere but the person's own Apify
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0), { timeout: 15_000, interval: 50 });
    expect(asked.filter((u) => !u.startsWith("https://api.apify.com/"))).toEqual([]);
  });
});

describe("in the assistant's dock", () => {
  it("each call shows its step, and only a post the call saved leaves a card, which opens it", async () => {
    const mac = pairDevice("ana", "Ana's Mac");
    await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");
    const cookie = (await app.request("/api/auth/login", json({ username: "ana", password: "password1" }))).headers.get("set-cookie")!.split(";")[0]!;
    expect((await app.request("/api/assistant/turn", json({ text: "Save this reel and tell me what it says" }, { cookie }))).status).toBe(202);
    // the Mac takes the reply's job: its token is the assistant's own, for that reply only
    const job = (await (await app.request("/api/devices/relay/wait", json({}, { authorization: `Bearer ${mac.token}` }))).json()) as { id: string; mcp: { token: string } };
    const token = `Bearer ${job.mcp.token}`;
    const saved = (await tool(token, "instagram_save", { links: ["https://www.instagram.com/p/TinyDock1/"] })).value.saved[0];
    await tool(token, "instagram_save", { links: ["https://www.instagram.com/reel/TinyRoll1/"] });
    await tool(token, "instagram_search", { q: "forward roll" });
    await tool(token, "instagram_post", { post: roll });
    const reply = ((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as AssistantView).messages.at(-1)!;
    // the same step twice in a row is one line
    expect(reply.steps).toEqual(["Saving to the Analyzer", "Searching your saved posts", "Reading the Instagram post"]);
    expect(reply.work).toEqual([{ id: `analyzer:${saved.id}`, kind: "link", title: "Saved post", href: `/instagram/${saved.id}`, status: "done", detail: "instagram.com/p/TinyDock1" }]);
    await app.request(`/api/devices/relay/${job.id}/done`, json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }));
  });
});
