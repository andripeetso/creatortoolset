import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * A file sent with a message from the iPhone app is a Media Library add (docs/media-library-proxies-prd.md R13, "The
 * chat"): it goes up by the phone's upload road, and the ask is kept until every one of its files is ready (uploaded,
 * and under Blur faces held, copied to the main computer and blurred there). Then it runs, once, on the asker's own AI.
 * "Restart" = every module loaded again over the same DATA_DIR (assistant-restart.test.ts).
 */
const DATA = (process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "assistant-adds-")));
process.env.APP_SECRET = "assistant-test-secret";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
// the team: the owner gave the member the workspace "kids-ws" (Settings → Team)
writeFileSync(
  path.join(DATA, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "tinyacrobatics",
        name: "Tiny Acrobatics",
        plan: "team",
        createdAt: 0,
        members: [
          { username: "tinyacrobatics", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "sam", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: ["kids-ws"] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);
mkdirSync(path.join(DATA, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(DATA, "workshop", "projects", "kids-ws.json"), JSON.stringify({ id: "kids-ws", owner: "tinyacrobatics", name: "Tiny Acrobatics", audience: "", voice: "", cta: "", notes: "", createdAt: 0, updatedAt: 0 }));
afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(DATA, { recursive: true, force: true });
});

vi.setConfig({ testTimeout: 30_000 });

// Face Blur's queue, stood in: what it says of each version (lib/plugin.ts DeviceJobSlot.preparing)
const blur = vi.hoisted(() => ({ jobs: [] as { versionId: string; running?: true; failed?: true; error?: string }[] }));
vi.mock("./lib/plugin", async (real) => ({
  ...(await real<typeof import("./lib/plugin")>()),
  pluginDeviceJobs: () => [{ kind: "faceblur-intake", waits: () => false, claim: () => null, preparing: () => blur.jobs }],
}));

type View = import("../contracts/assistant").AssistantView;
type Message = import("../contracts/assistant").AssistantMessage;
/** A reply for a Mac to write: `user` is its prompt. */
type Job = { id: string; user: string };
const LIB = "lib_kids";
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const post = (body: unknown, headers: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** The process before the newest one: it leaves when the next is up, as in a deploy's swap. */
let before: { leave: () => void } | undefined;

/** The server as a new process finds it: fresh modules, nothing in memory, the same files. */
async function boot() {
  before?.leave();
  vi.resetModules();
  const app = (await import("./boot")).default;
  const assistant = await import("./assistant");
  assistant.ADDS_POLL.ms = 30; // a waiting ask looks again this often
  assistant.CLAIM_STALE.ms = 500; // and a start claimed and not begun counts as lost this soon
  assistant.resumeFromDisk(); // what boot.ts does before it listens (not under tests)
  const server = {
    app,
    leave: (await import("./lib/sync")).leave,
    held: await import("./library/held"),
    db: (await import("./library/db")).libraryDb(),
    sweepAll: (await import("./assistant-files")).sweepAll,
    changeStorage: (await import("./devices-storage")).changeStorage,
    ...(await import("./auth")),
    ...(await import("./users")),
    ...(await import("./lib/devices")),
    ...(await import("./lib/providers")),
    ...(await import("../contracts/providers")),
  };
  before = server;
  return server;
}
type Server = Awaited<ReturnType<typeof boot>>;

/** An account with its own Mac running Claude Code, signed in on its phone; `on(server)` is that person talking to one server process. */
async function person(s: Server, name: string) {
  s.setOff(s.createUser(name, "password1"), []); // every tool on
  const mac = s.pairDevice(name, `${name}'s Mac`);
  const provider = (on: Server, there: boolean) =>
    on.saveSettings({ ...structuredClone(on.DEFAULT_SETTINGS), instances: there ? [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] : [] }, name);
  await provider(s, true);
  // the iPhone app's own session, in the workspace its chat is in
  const phone = { cookie: s.sessionCookieFor(name, true)!, "x-ct-origin": "phone", "x-ct-workspace": "kids-ws" };
  const device = { authorization: `Bearer ${mac.token}` };
  return (on: Server) => {
    const view = async () => (await (await on.app.request("/api/assistant", { headers: phone })).json()) as View;
    /** The phone starts an upload of a file (its bytes not sent yet): the upload's id. */
    const start = async (filename: string, bytes: string) => {
      const r = await on.app.request(`/api/library/${LIB}/uploads`, post({ filename, size: bytes.length }, phone));
      expect(r.status).toBe(201);
      return ((await r.json()) as { id: string }).id;
    };
    /** Its bytes, then finish: what the server answers (the clip, held for the main computer; or the clip the library had). */
    const finish = async (id: string, bytes: string) => {
      expect((await on.app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { ...phone, "upload-offset": "0", "content-length": String(bytes.length) }, body: bytes })).status).toBe(204);
      return (await (await on.app.request(`/api/library/uploads/${id}/finish`, { method: "POST", headers: phone })).json()) as { assetId?: string; versionId?: string; held?: boolean; duplicateOf?: string };
    };
    return {
      mac: mac.device.id,
      provider: (there: boolean) => provider(on, there),
      start,
      finish,
      send: (text: string, uploads: string[]) => on.app.request("/api/assistant/turn", post({ text, uploads }, phone)),
      messages: async () => (await view()).messages,
      reply: async () => (await view()).messages.at(-1)!,
      stop: () => on.app.request("/api/assistant/stop", post({}, phone)),
      newChat: () => on.app.request("/api/assistant", { method: "DELETE", headers: phone }),
      deleteChat: (id: string) => on.app.request(`/api/assistant/past/${id}`, { method: "DELETE", headers: phone }),
      past: async () => (await view()).past,
      /** Its Mac asks for the next reply to write; null when the poll ends with none (25 s, or the process leaves). */
      claim: async () => {
        const r = await on.app.request("/api/devices/relay/wait", post({}, device));
        return r.status === 200 ? ((await r.json()) as Job) : null;
      },
      done: (job: string, text: string) => on.app.request(`/api/devices/relay/${job}/done`, post({ text, usage: { input: 1, output: 1, cost_usd: 0 } }, device)),
      keepAsFilmed: (assetId: string) => on.app.request(`/api/library/${LIB}/assets/${assetId}/blur`, { method: "PUT", headers: { "content-type": "application/json", ...phone }, body: JSON.stringify({ blur: "no" }) }),
    };
  };
}

const first = await boot();
first.db.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'tinyacrobatics', 'L', 'local', ?, 0)").run(
  LIB,
  JSON.stringify({ upload: "originals", blurFaces: true, proxy: false, describe: false, embed: false, transcribe: false, projectId: "kids-ws" }),
);
const tiny = await person(first, "tinyacrobatics");
const sam = await person(first, "sam");
// the main computer: the library owner's, with the workspace's Source media folder
await first.changeStorage("tinyacrobatics", (st) => {
  st.folders.push({ id: "tiny-media", role: "footage", name: "Source media", origin: { host: tiny(first).mac, path: "/Volumes/Media/Source media" }, make: true, createdAt: Date.now(), reach: {}, workspace: "kids-ws" });
});

/** The main computer has copied the held file into Imports (its library save came back). */
async function landed(on: Server, versionId: string) {
  const v = on.db.prepare("SELECT bytes, quick FROM asset_versions WHERE id = ?").get(versionId) as { bytes: number; quick: string };
  await on.held.heldLanded(versionId, tiny(on).mac, "tiny-media", { path: `/Volumes/Media/Source media/Imports/${versionId}.mov`, size: v.bytes, quick: v.quick });
}
/** The conversation file as it is on disk: what a restart finds. */
const onDisk = (name: string) => JSON.parse(readFileSync(path.join(DATA, "assistant", `${name}.json`), "utf-8")) as { held?: Record<string, unknown> };
const waits = (m: Message) => ({ status: m.status, wait: m.wait?.text });

describe("a message sent from the phone with files that are not ready", () => {
  it("is kept, says what it waits for, goes on over a restart and runs once every file is ready: once", async () => {
    const me = tiny(first);
    const [a, b] = [await me.start("a.mov", "the first clip"), await me.start("b.mov", "the second clip, longer")];
    expect((await me.send("Edit a short video of these", [a, b])).status).toBe(202);
    expect((await me.messages()).at(-2)).toMatchObject({ role: "user", adds: [{ id: a, name: "a.mov", libraryId: LIB }, { id: b, name: "b.mov", libraryId: LIB }] });
    expect(waits(await me.reply())).toEqual({ status: "thinking", wait: "Uploading 1 of 2" });

    const one = await me.finish(a, "the first clip");
    expect(one.held).toBe(true);
    await vi.waitFor(async () => expect(waits(await me.reply())).toEqual({ status: "thinking", wait: "Uploading 2 of 2" }));
    // the message knows the clip its upload became: the phone reads how far it is from the library's intake
    expect((await me.messages()).at(-2)!.adds![0]).toMatchObject({ id: a, assetId: one.assetId });
    const two = await me.finish(b, "the second clip, longer");
    await vi.waitFor(async () => expect(waits(await me.reply())).toEqual({ status: "thinking", wait: "Waiting for the main computer" }));

    // the server restarts while the ask waits: it is still there, and still waiting
    const second = await boot();
    const now = tiny(second);
    await vi.waitFor(async () => expect(waits(await now.reply())).toEqual({ status: "thinking", wait: "Waiting for the main computer" }));
    await landed(second, one.versionId!);
    await landed(second, two.versionId!);
    blur.jobs = [{ versionId: one.versionId!, running: true }, { versionId: two.versionId! }]; // the second waits its turn in Face Blur's queue
    await vi.waitFor(async () => expect(waits(await now.reply())).toEqual({ status: "thinking", wait: "Blurring 1 of 2" }));
    await now.keepAsFilmed(one.assetId!);
    await vi.waitFor(async () => expect(waits(await now.reply())).toEqual({ status: "thinking", wait: "Blurring 2 of 2" }));
    blur.jobs = [];
    await now.keepAsFilmed(two.assetId!);

    // every file is ready: the reply starts by itself, on the asker's own Mac, with the clips as the library has them
    const job = (await now.claim())!;
    // told as clips the library has, by the version the tools take
    expect(job.user).toContain("Edit a short video of these");
    for (const clip of (await now.messages()).at(-2)!.clips!) expect(job.user).toContain(`version_id ${clip.versionId}`);
    expect((await now.messages()).at(-2)!.clips).toMatchObject([{ id: one.assetId }, { id: two.assetId }]);
    expect(waits(await now.reply())).toEqual({ status: "thinking", wait: undefined });
    expect((await now.done(job.id, "Here is the edit.")).status).toBe(200);
    await vi.waitFor(async () => expect(await now.reply()).toMatchObject({ status: "done", text: "Here is the edit." }));

    // a late answer (the main computer's again, the library's own settle, the next look) and one more restart: it does not start again
    await second.held.settleHeld(one.versionId!);
    await second.held.resumeHeld();
    await tick(1100); // the last save of the chat, and many looks
    const third = await boot();
    await tick();
    const end = await tiny(third).messages();
    expect(end.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(end.at(-1)).toMatchObject({ status: "done", text: "Here is the edit." });
    expect(end.at(-2)!.clips).toHaveLength(2);
    expect(onDisk("tinyacrobatics").held ?? {}).toEqual({});
  });

  it("a file the library has already is not added again: the chat uses the clip that is there", async () => {
    const s = await boot();
    const me = tiny(s);
    const there = s.db.prepare("SELECT id, current_version_id AS v, title FROM assets WHERE library_id = ? AND title = 'a'").get(LIB) as { id: string; v: string; title: string };
    const again = await me.start("a copy.mov", "the first clip");
    await me.send("Caption this one", [again]);
    expect(await me.finish(again, "the first clip")).toEqual({ duplicateOf: there.id });
    const job = (await me.claim())!;
    expect((await me.messages()).at(-2)!.clips).toEqual([{ id: there.id, versionId: there.v, title: there.title }]);
    await me.done(job.id, "Captioned.");
    expect((s.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ? AND trashed_at IS NULL").get(LIB) as { n: number }).n).toBe(2);
  });

  it("a file that failed stops the wait and says which and why; after its retry the ask goes on", async () => {
    const s = await boot();
    const me = tiny(s);
    const up = await me.start("party.mov", "a party");
    await me.send("Cut the best moment", [up]);
    const clip = await me.finish(up, "a party");
    await landed(s, clip.versionId!);
    blur.jobs = [{ versionId: clip.versionId!, failed: true, error: "The video could not be read" }];
    await vi.waitFor(async () =>
      expect((await me.reply()).wait).toEqual({ for: "files", text: 'Could not blur "party.mov": The video could not be read', failed: { part: "blur", libraryId: LIB, assetId: clip.assetId, versionId: clip.versionId } }),
    );
    expect((await me.reply()).status).toBe("thinking"); // kept, not run and not ended
    // its retry (Face Blur's own) takes it up again, and it ends blurred or decided: the ask runs
    blur.jobs = [{ versionId: clip.versionId!, running: true }];
    await vi.waitFor(async () => expect(waits(await me.reply())).toEqual({ status: "thinking", wait: "Blurring" }));
    blur.jobs = [];
    await me.keepAsFilmed(clip.assetId!);
    const job = (await me.claim())!;
    await me.done(job.id, "Cut.");
    await vi.waitFor(async () => expect(await me.reply()).toMatchObject({ status: "done", text: "Cut." }));
  });

  it("is dropped, not run, when its chat was deleted or one of its files was removed", async () => {
    const s = await boot();
    const me = tiny(s);
    // the chat deleted while it waits
    const gone = await me.start("gone.mov", "a clip of a chat that goes");
    await me.send("Edit this", [gone]);
    const clip = await me.finish(gone, "a clip of a chat that goes");
    await me.newChat();
    const past = (await me.past())[0]!;
    expect((await me.deleteChat(past.id)).status).toBe(200);
    await landed(s, clip.versionId!);
    await me.keepAsFilmed(clip.assetId!);
    await tick();
    expect(await me.messages()).toEqual([]);
    expect(onDisk("tinyacrobatics").held ?? {}).toEqual({});

    // a file of the ask removed while it waits: its clip goes to the trash
    const [kept, removed] = [await me.start("kept.mov", "a clip that stays"), await me.start("removed.mov", "a clip that is removed")];
    await me.send("Edit these two", [kept, removed]);
    await me.finish(kept, "a clip that stays");
    const out = await me.finish(removed, "a clip that is removed");
    s.db.prepare("UPDATE assets SET trashed_at = ? WHERE id = ?").run(Date.now(), out.assetId!);
    await vi.waitFor(async () => expect(await me.reply()).toMatchObject({ status: "error", text: '"removed.mov" is not in the Media Library, so this message got no reply: add it again and send the message again.' }));
    expect((await me.reply()).wait).toBeUndefined();
    expect(onDisk("tinyacrobatics").held ?? {}).toEqual({});

    // an upload that is not the sender's own is no file of theirs
    const theirs = await sam(s).start("sams.mov", "a clip of sam");
    expect((await me.send("Edit sam's", [theirs])).status).toBe(400);
    await me.newChat();
  });

  it("runs on the asker's own AI provider, never on another person's: with none left it says so", async () => {
    const s = await boot();
    const [member, owner] = [sam(s), tiny(s)];
    const up = await member.start("team.mov", "a clip from the member");
    await member.send("Make a reel of this", [up]);
    const clip = await member.finish(up, "a clip from the member");
    expect(clip.held).toBe(true);
    // while it waits the member's provider is removed; the owner's Mac, which blurs the file, has a provider of its own
    await member.provider(false);
    await landed(s, clip.versionId!);
    await owner.keepAsFilmed(clip.assetId!);
    await vi.waitFor(async () => expect(await member.reply()).toMatchObject({ status: "error", text: "Needs an AI provider" }));
    expect(await owner.messages()).toEqual([]);

    // with the member's own provider it runs there
    await member.provider(true);
    const next = await member.start("team 2.mov", "a second clip from the member");
    await member.send("And of this", [next]);
    const second = await member.finish(next, "a second clip from the member");
    await landed(s, second.versionId!);
    await owner.keepAsFilmed(second.assetId!);
    const job = (await member.claim())!;
    expect(job.user).toContain("And of this"); // the member's own Mac has it
    await member.done(job.id, "Made.");
    expect(await owner.messages()).toEqual([]);
  });

  it("a reply another server process has started (a deploy's swap) is not started again here", async () => {
    const s = await boot();
    const me = tiny(s);
    const up = await me.start("swap.mov", "a clip sent during a deploy");
    await me.send("Edit this", [up]);
    const clip = await me.finish(up, "a clip sent during a deploy");
    await landed(s, clip.versionId!);
    // on the main computer with no blur running or able to start: it says it waits for that computer, not that it is blurring
    await vi.waitFor(async () => expect(waits(await me.reply())).toEqual({ status: "thinking", wait: "Waiting for the main computer" }));
    // the other process took it: its claim is in the database both read
    s.db.prepare("INSERT INTO chat_starts (reply, at) VALUES (?, ?)").run((await me.reply()).id, Date.now());
    const claim = me.claim();
    await me.keepAsFilmed(clip.assetId!);
    await tick(300); // many looks with the file ready
    expect((await me.messages()).at(-2)!.clips).toBeUndefined();
    // the process that took it stopped before it saved: once its claim is old and the reply still waits here, the reply
    // ends saying to send again, and is never started a second time (its first start may have reached the AI)
    s.db.prepare("UPDATE chat_starts SET at = ? WHERE reply = ?").run(Date.now() - 2 * 60_000, (await me.reply()).id);
    await vi.waitFor(async () => expect(await me.reply()).toMatchObject({ status: "error", text: "This message got no reply: send it again." }), 4000);
    expect((await me.messages()).at(-2)!.clips).toBeUndefined();
    s.leave(); // a poll with no reply to write ends
    expect(await claim).toBeNull();
    await me.newChat();
  });

  it("nothing goes for its age: the ask and its held file wait for the main computer, forty days", async () => {
    const s = await boot();
    const me = tiny(s);
    const up = await me.start("patient.mov", "a clip that waits");
    await me.send("Edit this when it is ready", [up]);
    const clip = await me.finish(up, "a clip that waits");
    await vi.waitFor(async () => expect(waits(await me.reply())).toEqual({ status: "thinking", wait: "Waiting for the main computer" }));
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + 40 * 86_400_000);
    try {
      await s.sweepAll();
      await tick(); // many looks, forty days on
      expect(existsSync(s.held.heldFile(clip.versionId!))).toBe(true);
      expect(s.db.prepare("SELECT state, version_id FROM uploads WHERE id = ?").get(up)).toEqual({ state: "done", version_id: clip.versionId });
    } finally {
      clock.mockRestore();
    }
    expect(waits(await me.reply())).toEqual({ status: "thinking", wait: "Waiting for the main computer" });
    // and then it is there: the ask runs
    await landed(s, clip.versionId!);
    await me.keepAsFilmed(clip.assetId!);
    const job = (await me.claim())!;
    await me.done(job.id, "Edited.");
    await vi.waitFor(async () => expect(await me.reply()).toMatchObject({ status: "done", text: "Edited." }));
  });
});
