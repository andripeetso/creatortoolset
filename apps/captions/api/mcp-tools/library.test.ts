import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard } from "../../contracts/library";
import type { AssistantView } from "../../contracts/assistant";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-library-"));
process.env.APP_SECRET = "mcp-library-secret";

/**
 * A made-up plug-in, built into this server as scripts/plugins.mjs would build one in: it adds a second source to the
 * Media Library ("Tiny archive": two clips, hidden from nico) and answers the library's own path for one of them.
 * `seen` keeps what its list was handed, `late` makes it slow.
 */
const tiny = vi.hoisted(() => ({ seen: [] as Array<{ user: string; q: string | null; authorization: string; cookie: string | null }>, late: 0 }));
vi.mock("../plugins.gen", async () => {
  const { Hono } = await import("hono");
  const clips = [
    { n: "1", kind: "video" as const, title: "Beach cartwheel from the archive", durationS: 12 },
    { n: "2", kind: "image" as const, title: "Beach photo from the archive" },
  ];
  const refOf = async (c: (typeof clips)[number]) => (await import("../library/refs")).externalRefFor("tiny-archive", "clip", c.n, c.title)!;
  const cardOf = async (c: (typeof clips)[number]): Promise<AssetCard> => ({
    id: (await refOf(c)).id, libraryId: "", kind: c.kind, title: c.title, versionId: "", versionN: 0, tags: [], aiTags: [], state: "ready", ...(c.durationS ? { durationS: c.durationS } : {}),
  });
  const libraryRoutes = new Hono<{ Variables: { user: { username: string } } }>();
  // one clip in full, on the path the library's own clips have: the plug-in checks its own rule here
  libraryRoutes.get("/:lib/assets/:id", async (c, next) => {
    const id = c.req.param("id");
    if (!id.startsWith("ext_")) return next();
    const first = await cardOf(clips[0]!);
    if (id !== first.id || c.get("user").username === "nico") return next();
    return c.json({ ...first, libraryId: c.req.param("lib"), description: { text: "A cartwheel on wet sand.", source: "ai" }, versions: [], collections: [], jobs: [], link: "/x/tiny/clips/1" });
  });
  return {
    serverPlugins: [
      {
        id: "tiny",
        library: {
          source: {
            id: "tiny-archive",
            label: "Tiny archive",
            list: async (viewer: { username: string }, req: Request) => {
              const q = new URL(req.url).searchParams.get("q");
              tiny.seen.push({ user: viewer.username, q, authorization: req.headers.get("authorization") ?? "", cookie: req.headers.get("cookie") });
              if (tiny.late) await new Promise((done) => setTimeout(done, tiny.late));
              return Promise.all(clips.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase())).map(cardOf));
            },
          },
          policies: [{ sourceId: "tiny-archive", canSee: (viewer: { username: string }) => viewer.username !== "nico" }],
        },
        libraryRoutes,
      },
    ],
  };
});

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("../library/db");
const { indexAsset } = await import("../library/query");
const { saveTranscript } = await import("../library/transcribe");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const key = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
/** One tool call through POST /api/mcp, against the app's real routes. */
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = ((await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization }) })).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.isError, text: r.content[0]!.text, get value(): any { return JSON.parse(r.content[0]!.text); } };
};
const get = async <T>(url: string, authorization = key) => (await (await app.request(url, { headers: { authorization } })).json()) as T;
const cookieOf = async (username: string) => (await app.request("/api/auth/login", { method: "POST", ...json({ username, password: "password1" }) })).headers.get("set-cookie")!.split(";")[0]!;

// ana's own library, as GET /api/library makes it, and three made-up clips in it
const LIB = (await get<{ libraries: Array<{ id: string }> }>("/api/library")).libraries[0]!.id;
const SHOT = Date.parse("2026-11-09T15:30:00Z");
const LONG = `Two children practise on a blue mat in a bright gym. ${"The camera stays wide and still. ".repeat(20)}`.trim();
function seed(id: string, title: string, o: { roll?: "a" | "b"; filed?: "none"; at?: number; kind?: string; tags?: string[]; ai?: string; said?: string[] } = {}) {
  const d = libraryDb();
  const at = o.at ?? Date.parse("2026-11-01T10:00:00Z");
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll, filed_roll) VALUES (?, ?, ?, ?, ?, 'ana', ?, ?, ?)").run(id, LIB, o.kind ?? "video", title, `${id}-v1`, at, o.roll ?? null, o.filed ?? null);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, 'video/mp4', ?, 'ready', 'ana', ?)").run(
    `${id}-v1`, id, `h-${id}`, JSON.stringify({ duration: 42, vcodec: "h264", acodec: "aac", width: 1920, height: 1080, capturedAt: SHOT }), at,
  );
  for (const t of o.tags ?? []) d.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')").run(id, t);
  if (o.ai) d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES (?, 'ai', ?, 'test', ?)").run(`${id}-v1`, o.ai, at);
  if (o.said) saveTranscript(d, `${id}-v1`, "test", "en", o.said.map((text, i) => ({ start: i * 4, end: i * 4 + 4, text })));
  indexAsset(d, id);
}
seed("clip-talk", "Beach talk to the camera", { roll: "a", tags: ["beach", "talk"], ai: LONG, said: ["Today we practise the forward roll.", "Tuck the chin before the mat."], at: Date.parse("2026-11-10T10:00:00Z") });
seed("clip-broll", "Beach waves", { roll: "b" });
seed("clip-done", "Tiny Acrobatics reel, finished", { filed: "none" });
seed("clip-long", "A long talk", { roll: "a", said: Array.from({ length: 700 }, () => "we tumble and we tumble again") });
// someone else's clip, in their own library
const NICO_LIB = (await get<{ libraries: Array<{ id: string }> }>("/api/library", nicoKey)).libraries[0]!.id;
libraryDb().prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('clip-nico', ?, 'video', 'Not yours', 'clip-nico-v1', 'nico', 1)").run(NICO_LIB);
libraryDb().prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES ('clip-nico-v1', 'clip-nico', 1, 'k', 1, 'h-nico', 'video/mp4', 'ready', 'nico', 1)").run();

const folders = async () => (await get<{ collections: Array<{ id: string; name: string; kind: string; count?: number }> }>(`/api/library/${LIB}/collections`)).collections;
const shares = async () => (await get<{ shares: Array<{ target: { kind: string; id: string }; scope: string }> }>(`/api/library/${LIB}/shares`)).shares;
const rollOf = (id: string) => (libraryDb().prepare("SELECT roll, filed_roll FROM assets WHERE id = ?").get(id) as { roll: string | null; filed_roll: string | null });

describe("the media tools follow the install's library", () => {
  it("media_search looks in the library and in the source a plug-in adds, and each hit says where it is from", async () => {
    tiny.seen.length = 0;
    const out = (await tool(key, "media_search", { q: "beach" })).value;
    expect(out.sources).toEqual(["Library", "Tiny archive"]);
    expect(out.files.map((f: { title: string; source: string }) => [f.title, f.source])).toEqual([
      ["Beach talk to the camera", "Library"],
      ["Beach waves", "Library"],
      ["Beach cartwheel from the archive", "Tiny archive"],
      ["Beach photo from the archive", "Tiny archive"],
    ]);
    expect(out.files[2]).toMatchObject({ id: expect.stringMatching(/^ext_/), kind: "video", state: "ready", durationS: 12 });
    expect(out.note).toBeUndefined();
    // the source is asked through the library's own route, as the caller: the AI key and no cookie
    expect(tiny.seen).toEqual([{ user: "ana", q: "beach", authorization: key, cookie: null }]);
  });

  it("kind is applied to a source's hits; roll, since, a folder and version ids are not its own, and the answer says so", async () => {
    const videos = (await tool(key, "media_search", { q: "beach", kind: "video" })).value;
    expect(videos.files.map((f: { title: string }) => f.title)).toEqual(["Beach talk to the camera", "Beach waves", "Beach cartwheel from the archive"]);
    expect(videos.note).toBeUndefined();

    const aRoll = (await tool(key, "media_search", { q: "beach", roll: "a", since: "2026-11-09T00:00:00Z" })).value;
    expect(aRoll.files.filter((f: { source: string }) => f.source === "Library").map((f: { id: string }) => f.id)).toEqual(["clip-talk"]);
    expect(aRoll.files.filter((f: { source: string }) => f.source === "Tiny archive")).toHaveLength(2);
    expect(aRoll.note).toBe(
      "Tiny archive does not sort A-roll and B-roll: roll was not applied to it. Tiny archive does not say when a clip was added: since was not applied to it (captured is when a clip was shot).",
    );

    const made = (await tool(key, "media_add_to_folder", { name: "Beach days", clips: ["clip-broll"] })).value;
    tiny.seen.length = 0;
    const inFolder = (await tool(key, "media_search", { folder: made.folder })).value;
    expect(inFolder).toMatchObject({ sources: ["Library"], note: "A folder and version ids are the Library's own: Tiny archive not searched." });
    expect(inFolder.files.map((f: { id: string }) => f.id)).toEqual(["clip-broll"]);
    const byVersion = (await tool(key, "media_search", { versions: ["clip-talk-v1"] })).value;
    expect(byVersion).toMatchObject({ said: "1 clip added: 1 A-roll", sources: ["Library"], files: [{ id: "clip-talk", source: "Library" }] });
    expect(tiny.seen).toEqual([]);
  });

  it("a source that takes too long is named, and the library's own hits still come", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    tiny.late = 120_000;
    try {
      const call = tool(key, "media_search", { q: "beach" });
      await vi.advanceTimersByTimeAsync(51_000);
      const out = (await call).value;
      expect(out.files.map((f: { source: string }) => f.source)).toEqual(["Library", "Library"]);
      expect(out.note).toBe("Tiny archive did not answer.");
    } finally {
      tiny.late = 0;
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("an account the source is hidden from gets the library alone, in the answer an install with no plug-in gets", async () => {
    tiny.seen.length = 0;
    expect((await tool(nicoKey, "media_search", { q: "beach" })).value).toEqual({ library: NICO_LIB, files: [] });
    expect((await tool(nicoKey, "media_folders")).value).toEqual({ library: NICO_LIB, folders: [] });
    expect(tiny.seen).toEqual([]);
  });

  it("media_folders says which sources have no folders here", async () => {
    const out = (await tool(key, "media_folders")).value;
    expect(out.folders.map((f: { name: string }) => f.name)).toContain("Beach days");
    expect(out.note).toBe("These are the Library's own folders. media_search also searches, with no folders here: Tiny archive.");
  });
});

describe("media_get", () => {
  it("reads one clip in full: its roll, its whole description, what is said in it, its folders and its link", async () => {
    await tool(key, "media_add_to_folder", { name: "Talks", clips: ["clip-talk"] });
    const talks = (await folders()).find((f) => f.name === "Talks")!;
    expect((await tool(key, "media_get", { id: "clip-talk" })).value).toEqual({
      id: "clip-talk",
      versionId: "clip-talk-v1",
      title: "Beach talk to the camera",
      kind: "video",
      state: "ready",
      durationS: 42,
      roll: "a",
      tags: ["beach", "talk"],
      captured: "2026-11-09 15:30",
      description: LONG,
      description_by: "AI",
      transcript: "Today we practise the forward roll. Tuck the chin before the mat.",
      folders: [{ id: talks.id, name: "Talks" }],
      link: `/library?library=${LIB}&asset=clip-talk`,
    });
    expect(LONG.length).toBeGreaterThan(300); // media_search cuts a description there; this one is whole
  });

  it("finished work says finished and has no roll; a long recording is cut and says so", async () => {
    const done = (await tool(key, "media_get", { id: "clip-done" })).value;
    expect(done).toMatchObject({ id: "clip-done", finished: true });
    expect(done.roll).toBeUndefined();
    expect(done.transcript).toBeUndefined();
    const long = (await tool(key, "media_get", { id: "clip-long" })).value.transcript as string;
    expect(long.length).toBeLessThan(12_200);
    expect(long).toContain("(cut: 20,999 characters in all; the page has the rest)");
  });

  it("someone else's clip is not found, and a missing id is asked for", async () => {
    expect(await tool(key, "media_get", { id: "clip-nico" })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    expect(await tool(key, "media_get")).toMatchObject({ error: true, text: "Give the clip's id (media_search lists them)." });
  });

  it("a source's clip comes with what its plug-in answers, and no more; one it does not answer for is said plainly", async () => {
    const [first, second] = (await tool(key, "media_search", { q: "archive" })).value.files as Array<{ id: string }>;
    expect((await tool(key, "media_get", { id: first!.id })).value).toEqual({
      id: first!.id,
      title: "Beach cartwheel from the archive",
      kind: "video",
      state: "ready",
      durationS: 12,
      description: "A cartwheel on wet sand.",
      description_by: "AI",
      link: "/x/tiny/clips/1",
    });
    const plain = "This clip is from a source a plug-in adds, and that source has no more to read than media_search shows.";
    expect(await tool(key, "media_get", { id: second!.id })).toMatchObject({ error: true, text: plain });
    // the plug-in's own rule holds on that path: the account its source is hidden from reads nothing
    expect(await tool(nicoKey, "media_get", { id: first!.id })).toMatchObject({ error: true, text: plain });
  });
});

describe("media_update", () => {
  it("changes the title, the whole tag list and the description; an empty description gives the AI's back", async () => {
    const out = (await tool(key, "media_update", { id: "clip-broll", title: "Beach waves at dusk", tags: ["dusk", "sea"], description: "Waves, low sun." })).value;
    expect(out).toEqual({ id: "clip-broll", title: "Beach waves at dusk", tags: ["dusk", "sea"], description: "Waves, low sun.", description_by: "the user", link: `/library?library=${LIB}&asset=clip-broll` });
    expect((await tool(key, "media_search", { q: "dusk" })).value.files.map((f: { id: string }) => f.id)).toEqual(["clip-broll"]);

    // clip-talk has the AI's description: the person's own goes over it, and "" takes theirs away again
    expect((await tool(key, "media_update", { id: "clip-talk", description: "Mine." })).value).toMatchObject({ description: "Mine.", description_by: "the user" });
    expect((await tool(key, "media_update", { id: "clip-talk", description: "", tags: [] })).value).toMatchObject({ description: LONG, description_by: "AI", tags: [] });
  });

  it("has no roll to set, refuses a call with nothing to change, and leaves a source's clip alone", async () => {
    const listed = ((await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: key }) })).json()) as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools;
    expect(Object.keys(listed.find((t) => t.name === "media_update")!.inputSchema.properties)).toEqual(["id", "title", "tags", "description"]);
    expect(await tool(key, "media_update", { id: "clip-broll", roll: "a" })).toMatchObject({ error: true, text: "Nothing to change: give a title, tags or a description." });
    expect(rollOf("clip-broll").roll).toBe("b");
    expect(await tool(key, "media_update", { id: "clip-nico", title: "Mine now" })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    const ext = ((await tool(key, "media_search", { q: "archive" })).value.files as Array<{ id: string }>)[0]!.id;
    expect(await tool(key, "media_update", { id: ext, title: "Renamed" })).toMatchObject({ error: true, text: "This clip is from a source a plug-in adds: it is changed where that source keeps it, not here." });
  });
});

describe("media_add_to_folder", () => {
  it("makes a plain folder by name and files the clips; a folder by its id takes more, and says what was already there", async () => {
    const made = (await tool(key, "media_add_to_folder", { name: "Tiny tumbles", clips: ["clip-talk", "clip-broll"] })).value;
    expect(made).toEqual({ folder: expect.stringMatching(/^col_/), name: "Tiny tumbles", made: true, added: 2 });
    expect((await folders()).find((f) => f.id === made.folder)).toMatchObject({ name: "Tiny tumbles", kind: "manual", count: 2 });
    const more = (await tool(key, "media_add_to_folder", { folder: made.folder, clips: ["clip-broll", "clip-long", "clip-nico"] })).value;
    expect(more).toEqual({ folder: made.folder, name: "Tiny tumbles", added: 1, note: "2 of the 3 were in it already, or are not clips of this library." });
    expect((await tool(key, "media_search", { folder: made.folder })).value.files.map((f: { id: string }) => f.id).sort()).toEqual(["clip-broll", "clip-long", "clip-talk"]);
  });

  it("never files into Finals, by id or by name, nor into a folder that fills itself, and a refusal makes no folder", async () => {
    const { finalsCollectionId } = await import("../library/finals");
    const finals = finalsCollectionId(LIB);
    const smart = await (await app.request(`/api/library/${LIB}/collections`, { method: "POST", ...json({ name: "A-roll", kind: "smart", query: { roll: "a" } }, { authorization: key }) })).json() as { id: string };
    const before = (await folders()).length;
    const notFinals = "Finals is not a Media Library folder: a finished video goes there from Review or the AI Editor.";
    expect(await tool(key, "media_add_to_folder", { folder: finals, clips: ["clip-broll"] })).toMatchObject({ error: true, text: notFinals });
    expect(await tool(key, "media_add_to_folder", { name: "finals", clips: ["clip-broll"] })).toMatchObject({ error: true, text: notFinals });
    // the A-roll folder would file the clip as A-roll: the app sorts that, nobody switches it by hand
    expect(await tool(key, "media_add_to_folder", { folder: smart.id, clips: ["clip-broll"] })).toMatchObject({ error: true, text: '"A-roll" fills itself from a search: pick a plain folder (kind manual), or give name to make one.' });
    expect(rollOf("clip-broll")).toEqual({ roll: "b", filed_roll: null });
    const ext = ((await tool(key, "media_search", { q: "archive" })).value.files as Array<{ id: string }>)[0]!.id;
    expect(await tool(key, "media_add_to_folder", { name: "From the archive", clips: [ext] })).toMatchObject({ error: true, text: "A clip from a source a plug-in adds is not the Library's to file: leave those out." });
    expect((await tool(key, "media_add_to_folder", { name: "Both", folder: finals, clips: ["clip-broll"] })).error).toBe(true);
    expect((await tool(key, "media_add_to_folder", { name: "Empty", clips: [] })).error).toBe(true);
    expect(await tool(key, "media_add_to_folder", { folder: "col_nope", clips: ["clip-broll"] })).toMatchObject({ error: true, text: "No folder has that id: media_folders lists them." });
    expect((await folders()).length).toBe(before);
    expect((await get<{ items: unknown[] }>(`/api/library/${LIB}/assets?collectionId=${finals}`)).items).toEqual([]);
  });
});

describe("media_share", () => {
  const token = (link: string) => link.split("/library/s/")[1]!;
  const opened = async (link: string) => (await (await app.request(`/api/library/s/${token(link)}`)).json()) as { name: string; scope: string; items: Array<{ id: string; sourceUrl?: string }> };

  it("an AI key from outside gets the link at once: a clip to watch, a folder to watch and download", async () => {
    const one = (await tool(key, "media_share", { clip: "clip-talk" })).value;
    expect(one).toEqual({
      share_link: expect.stringMatching(/^http:\/\/localhost\/library\/s\/[A-Za-z0-9_-]{22}$/),
      shared: 'the clip "Beach talk to the camera"',
      viewers: "Anyone with the link can watch, no account needed, for 7 days",
      expires: expect.stringMatching(/^2\d{3}-\d\d-\d\d \d\d:\d\d UTC$/),
    });
    expect(await opened(one.share_link)).toMatchObject({ name: "Beach talk to the camera", scope: "view", items: [{ id: "clip-talk" }] });

    const tumbles = (await folders()).find((f) => f.name === "Tiny tumbles")!;
    const all = (await tool(key, "media_share", { folder: tumbles.id, download: true, days: 30 })).value;
    expect(all).toMatchObject({ shared: 'the folder "Tiny tumbles" (3 files)', viewers: "Anyone with the link can watch and download the files, no account needed, for 30 days" });
    const view = await opened(all.share_link);
    expect(view.scope).toBe("download");
    expect(view.items.map((i) => i.id).sort()).toEqual(["clip-broll", "clip-long", "clip-talk"]);
    expect(view.items[0]!.sourceUrl).toBeTruthy();
  });

  it("refuses what it cannot share, before anything is asked or made", async () => {
    const before = (await shares()).length;
    const { finalsCollectionId } = await import("../library/finals");
    const ext = ((await tool(key, "media_search", { q: "archive" })).value.files as Array<{ id: string }>)[0]!.id;
    expect(await tool(key, "media_share", {})).toMatchObject({ error: true, text: "Give clip (a clip's id) or folder (a folder's id), one of the two." });
    expect((await tool(key, "media_share", { clip: "clip-talk", folder: "x" })).error).toBe(true);
    expect(await tool(key, "media_share", { clip: "clip-talk", days: 400 })).toMatchObject({ error: true, text: "days is a whole number from 1 to 90." });
    expect(await tool(key, "media_share", { clip: "clip-nico" })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    expect(await tool(key, "media_share", { folder: finalsCollectionId(LIB) })).toMatchObject({ error: true, text: "Finals is not a Media Library folder: share a clip, or one of the library's own folders." });
    expect(await tool(key, "media_share", { clip: ext })).toMatchObject({ error: true, text: "A clip from a source a plug-in adds is shared where that source keeps it, not here." });
    expect((await shares()).length).toBe(before);
  });

  /** The Mac takes the reply's job: its token is the assistant's own, for that reply only. */
  const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; user: string; mcp: { token: string } };
  const viewOf = async (cookie: string) => (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as AssistantView;
  const turn = async (cookie: string, text: string) => {
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie }) })).status).toBe(202);
    const job = await claim();
    return { job, token: `Bearer ${job.mcp.token}`, end: () => app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) }) };
  };
  const answer = (cookie: string, id: string, yes: boolean) => app.request(`/api/assistant/confirms/${id}`, { method: "POST", ...json({ yes }, { cookie }) });

  it("in the assistant it asks first, naming the clip: no link until Yes, the link on the card after it, none on No", async () => {
    const cookie = await cookieOf("ana");
    const before = (await shares()).length;
    const t = await turn(cookie, "Send Mia a link to the beach talk");
    // the assistant's own search reaches the plug-in's source too, as the account the reply is for
    tiny.seen.length = 0;
    expect((await tool(t.token, "media_search", { q: "archive" })).value.sources).toEqual(["Library", "Tiny archive"]);
    expect(tiny.seen).toEqual([{ user: "ana", q: "archive", authorization: t.token, cookie: null }]);

    const asked = await tool(t.token, "media_share", { clip: "clip-talk" });
    expect(asked.error).toBe(false);
    expect(asked.text).toContain('Asked the user: "Share the clip "Beach talk to the camera"? Anyone with the link can watch, no account needed, for 7 days." Nothing has been changed.');
    await tool(t.token, "media_share", { folder: (await folders()).find((f) => f.name === "Tiny tumbles")!.id, download: true });
    // what it checks before it asks still answers at once
    expect(await tool(t.token, "media_share", { clip: "clip-nico" })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    await t.end();
    expect((await shares()).length).toBe(before);

    const reply = (await viewOf(cookie)).messages.at(-1)!;
    expect(reply.steps).toEqual(["Searching the Media Library", "Making a share link"]);
    expect(reply.confirms!.map((q) => [q.question, q.status])).toEqual([
      ['Share the clip "Beach talk to the camera"? Anyone with the link can watch, no account needed, for 7 days.', "waiting"],
      ['Share the folder "Tiny tumbles" (3 files)? Anyone with the link can watch and download the files, no account needed, for 7 days.', "waiting"],
    ]);

    expect((await answer(cookie, reply.confirms![1]!.id, false)).status).toBe(200);
    expect((await shares()).length).toBe(before);
    expect((await answer(cookie, reply.confirms![0]!.id, true)).status).toBe(200);
    const card = (await viewOf(cookie)).messages.at(-1)!.confirms![0]!;
    expect(card.status).toBe("done");
    // the card keeps the start of the answer: the whole link is in it
    const link = /http:\/\/localhost\/library\/s\/[A-Za-z0-9_-]{22}(?=")/.exec(card.result!)![0];
    expect(await opened(link)).toMatchObject({ scope: "view", items: [{ id: "clip-talk" }] });
    expect((await shares()).length).toBe(before + 1);

    const next = await turn(cookie, "And?");
    expect(next.job.user).toContain(`yes, done: { "share_link": "${link}"`);
    expect(next.job.user).toContain('"Share the folder "Tiny tumbles" (3 files)? Anyone with the link can watch and download the files, no account needed, for 7 days." → the user said no]');
    await next.end();
  });

  it("on a server on the person's own computer with no address on the internet, the question and the answer say the link opens here only", async () => {
    const cookie = await cookieOf("ana");
    process.env.CT_LOCAL = "1";
    try {
      const t = await turn(cookie, "A link to the waves");
      await tool(t.token, "media_share", { clip: "clip-broll" });
      await t.end();
      const card = (await viewOf(cookie)).messages.at(-1)!.confirms![0]!;
      expect(card.question).toBe('Share the clip "Beach waves at dusk"? Anyone with the link can watch, no account needed, for 7 days. The link opens only on this computer and its network.');
      expect((await answer(cookie, card.id, true)).status).toBe(200);
      const done = (await viewOf(cookie)).messages.at(-1)!.confirms![0]!;
      expect(done.status).toBe("done");
      expect(done.result).toMatch(/^\{ "share_link": "http:\/\/localhost\/library\/s\/[A-Za-z0-9_-]{22}", "note": "This link opens only on this computer and its network\./);
      // with an address on the internet the note goes, and the link starts with that address
      process.env.PUBLIC_ORIGIN = "https://tools.example.com";
      const out = (await tool(key, "media_share", { clip: "clip-broll" })).value;
      expect(out.note).toBeUndefined();
      expect(out.share_link).toMatch(/^https:\/\/tools\.example\.com\/library\/s\//);
    } finally {
      delete process.env.CT_LOCAL;
      delete process.env.PUBLIC_ORIGIN;
    }
  });
});
