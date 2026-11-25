import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// D14: one chat card for every client. Each card's actions, called as the iPhone app calls them (its app session),
// change the chat message on the change stream: the card goes (or the next one comes), and the ask goes on.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "action-cards-"));
process.env.APP_SECRET = "action-cards-secret";
delete process.env.CT_LOCAL;

const told: string[] = [];
vi.mock("./lib/sync", async (real) => {
  const m = await real<typeof import("./lib/sync")>();
  return { ...m, announce: (owner: string, topic: string, ...rest: [string | null, string?]) => (told.push(`${owner}:${topic}`), m.announce(owner, topic, ...rest)) };
});

const { createUser } = await import("./users");
const app = (await import("./boot")).default;
const { sessionCookieFor } = await import("./auth");
const { noteMachine, pairDevice, touchDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");
const { noteAction } = await import("./assistant");
const { ensureUseFolder, storageOf } = await import("./devices-storage");
const { setupNeeded, ensureLibrary } = await import("./library/access");
const { libraryDb } = await import("./library/db");
const { actionCard, cantFind, LIBRARY_WORDS, RETRY } = await import("../contracts/library");
type View = import("../contracts/assistant").AssistantView;
type Card = import("../contracts/library").ActionNeeded;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A person with a paired Mac running their AI, signed in as the iPhone app is (its app session cookie). */
async function person(name: string) {
  createUser(name, "password1");
  const mac = pairDevice(name, `${name}'s Mac`);
  noteMachine(mac.device.id, { host: `${name}-mac.local`, cpus: 8, memGb: 16 });
  touchDevice(mac.device.id);
  await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, name);
  const phone = { cookie: sessionCookieFor(name, true)!, "x-ct-origin": "phone" };
  const device = { authorization: `Bearer ${mac.token}`, "content-type": "application/json" };
  const view = async () => (await (await app.request("/api/assistant", { headers: phone })).json()) as View;
  const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", headers: device, body: "{}" })).json()) as { id: string };
  /** A reply whose tool stopped on `card`: the message under which every client draws it. */
  const asked = async (text: string, card: Card) => {
    const job = claim();
    const sent = await app.request("/api/assistant/turn", { method: "POST", headers: { ...phone, "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (sent.status !== 202) throw new Error(`turn: ${sent.status} ${await sent.text()}`);
    const { id } = await job;
    const reply = (await view()).messages.at(-1)!;
    noteAction(name, reply.id, card);
    await app.request(`/api/devices/relay/${id}/done`, { method: "POST", headers: device, body: JSON.stringify({ text: "It needs one thing first." }) });
    for (let i = 0; i < 50 && (await view()).messages.at(-1)?.status === "thinking"; i++) await tick();
    return (await view()).messages.find((m) => m.id === reply.id)!;
  };
  /** A card action's request, as the phone sends it (X-CT-Workspace when the call names one). */
  const act = (a: Card["actions"][number]) =>
    app.request(a.call!.path, {
      method: a.call!.method,
      headers: { ...phone, ...(a.call!.body ? { "content-type": "application/json" } : {}), ...(a.call!.workspace ? { "X-CT-Workspace": a.call!.workspace } : {}) },
      ...(a.call!.body ? { body: JSON.stringify(a.call!.body) } : {}),
    });
  const message = async (id: string) => (await view()).messages.find((m) => m.id === id);
  return { mac: mac.device.id, token: mac.token, phone, view, act, asked, message, claim };
}

/** A Workshop project (a workspace) of `owner`'s. */
function workspace(owner: string, id: string, name: string) {
  mkdirSync(path.join(process.env.DATA_DIR!, "workshop", "projects"), { recursive: true });
  writeFileSync(path.join(process.env.DATA_DIR!, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner, name, audience: "", voice: "", cta: "", notes: "", createdAt: 1, updatedAt: 1 }));
}

/** A workspace whose Media Library is set up (its setupAt): a folder card, not the setup card, is what an edit waits on. */
function setUp(owner: string, id: string) {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, ?, 'Library', 'local', ?, 0)").run(`lib_${id.replace(/-/g, "_")}`, owner, JSON.stringify({ projectId: id, setupAt: "2026-11-19T08:00:00.000Z" }));
}

describe("the Project files card", () => {
  it("use_default makes the row on its computer, the card goes on the change stream, and the job's claim finds the folder", async () => {
    const p = await person("ana");
    workspace("ana", "ws-ana", "Tiny Acrobatics");
    setUp("ana", "ws-ana");
    const r = await ensureUseFolder("ana", "ws-ana", "projects", p.mac);
    if (!("wait" in r)) throw new Error("expected a card");
    expect(r.wait).toMatchObject({ title: "Project files folder for Tiny Acrobatics", device: p.mac });
    expect(r.wait.actions.map((a) => a.id)).toEqual(["use_default", "choose"]);
    expect(r.wait.actions[1]!.browse).toEqual({ device: p.mac, role: "projects", workspace: "ws-ana", start: "~" });
    const m = await p.asked("cut my clips", r.wait);
    told.length = 0;
    expect((await p.act(m.action!.actions[0]!)).status).toBe(200);
    expect((await storageOf("ana")).folders.filter((f) => f.role === "projects")).toEqual([
      expect.objectContaining({ workspace: "ws-ana", make: true, origin: { host: p.mac, path: "~/Movies/Creator Toolset/Tiny Acrobatics/Project files" } }),
    ]);
    expect((await p.message(m.id))!.action).toBeUndefined();
    expect(told).toContain("ana:assistant");
    expect(await ensureUseFolder("ana", "ws-ana", "projects", p.mac)).toMatchObject({ role: "projects", workspace: "ws-ana" });
  });

  it("a row added in Settings → Folders clears a waiting card of that workspace and computer, never another's", async () => {
    const p = await person("bea");
    workspace("bea", "ws-bea", "Bea Studio");
    workspace("bea", "ws-bea2", "Second");
    setUp("bea", "ws-bea");
    setUp("bea", "ws-bea2");
    const one = await ensureUseFolder("bea", "ws-bea", "projects", p.mac);
    const two = await ensureUseFolder("bea", "ws-bea2", "projects", p.mac);
    const a = await p.asked("edit one", (one as { wait: Card }).wait);
    const b = await p.asked("edit two", (two as { wait: Card }).wait);
    // Settings → Folders: a browser session, a folder of its own choosing
    const settings = await app.request("/api/devices/storage/folders", {
      method: "POST",
      headers: { cookie: sessionCookieFor("bea", false)!, "content-type": "application/json", "X-CT-Workspace": "ws-bea" },
      body: JSON.stringify({ role: "projects", host: p.mac, path: "/Volumes/Edits/Bea Projects" }),
    });
    expect(settings.status).toBe(200);
    expect((await p.message(a.id))!.action).toBeUndefined();
    expect((await p.message(b.id))!.action).toMatchObject({ workspace: "ws-bea2" });
  });

  it("a computer nothing matches says so, offers only Retry, and Retry finds it once it is paired", async () => {
    const p = await person("cal");
    workspace("cal", "ws-cal", "Cal");
    setUp("cal", "ws-cal");
    const r = await ensureUseFolder("cal", "ws-cal", "projects", "Studio-Mini.local");
    if (!("wait" in r)) throw new Error("expected a card");
    expect(r.wait).toMatchObject({ missing: "computer", device: null, line: cantFind("Studio-Mini.local") });
    expect(r.wait.line).toBe("Can't find Studio-Mini.local right now: open Creator Toolset on it");
    const m = await p.asked("cut it", r.wait);
    expect(m.action!.actions).toEqual([{ id: "retry", label: RETRY, primary: true, call: { method: "GET", path: `/api/assistant/action/${m.id}` } }]);
    // still nowhere: the same card
    expect(((await (await p.act(m.action!.actions[0]!)).json()) as { action: Card }).action).toMatchObject({ missing: "computer" });
    // the Mini is paired now: Retry gives the card for it, with its default and Choose…
    const mini = pairDevice("cal", "Studio Mini");
    noteMachine(mini.device.id, { host: "studio-mini", cpus: 8, memGb: 16 });
    told.length = 0;
    const again = await p.act(m.action!.actions[0]!);
    expect(again.status).toBe(200);
    const now = (await p.message(m.id))!.action!;
    expect(now).toMatchObject({ device: mini.device.id, deviceName: "Studio Mini" });
    expect(now.missing).toBeUndefined();
    expect(now.actions.map((a) => a.id)).toEqual(["use_default", "choose"]);
    expect(told).toContain("cal:assistant");
  });
});

describe("the Downloads card", () => {
  it("turn_on writes Downloads needed, the card goes, and the ask goes on with the downloads words", async () => {
    const p = await person("dee");
    const lib = (await ensureLibrary("dee"))!;
    const card = actionCard({ kind: "downloads", libraryId: lib, workspace: "" });
    expect(card.actions).toEqual([expect.objectContaining({ id: "turn_on", call: { method: "PUT", path: "/api/library/offline/downloads", body: { library: lib, mode: "needed" }, workspace: "" } })]);
    const m = await p.asked("make a reel", card);
    const job = p.claim();
    told.length = 0;
    expect((await p.act(m.action!.actions[0]!)).status).toBe(200);
    expect((await p.message(m.id))!.action).toBeUndefined();
    expect(told).toContain("dee:assistant");
    await job;
    expect((await p.view()).messages.slice(-2)).toMatchObject([{ role: "user", text: LIBRARY_WORDS.downloadsDone("make a reel") }, { role: "assistant", status: "thinking" }]);
  });
});

describe("the setup card", () => {
  it("quick_setup writes the three rows and the settings with setupAt, the card goes, and the ask goes on", async () => {
    const p = await person("eve");
    const card = (await setupNeeded("eve")) as Extract<Card, { kind: "setup" }>;
    expect(card).toMatchObject({ kind: "setup", owner: true, device: p.mac, deviceName: "eve's Mac", defaults: { base: "~/Movies/Creator Toolset/Media Library", proxy: false, proxyQuality: "standard", effort: "high", organize: "smart" } });
    expect(card.line).not.toMatch(/prox/i); // the card makes none, so it promises none
    expect(card.actions.map((a) => a.id)).toEqual(["quick_setup", "customise"]);
    const m = await p.asked("import my clips", card);
    const job = p.claim();
    told.length = 0;
    const r = await p.act(m.action!.actions[0]!);
    expect(r.status).toBe(200);
    const rows = (await storageOf("eve")).folders.map((f) => [f.role, f.origin.host, f.origin.path, f.make]);
    expect(rows).toEqual([
      ["footage", p.mac, "~/Movies/Creator Toolset/Media Library/Source media", true],
      ["projects", p.mac, "~/Movies/Creator Toolset/Media Library/Project files", true],
      ["library", p.mac, "~/Movies/Creator Toolset/Media Library/Final exports", true],
    ]);
    const s = JSON.parse((libraryDb().prepare("SELECT settings FROM libraries WHERE id = ?").get(card.libraryId) as { settings: string }).settings);
    expect(s).toMatchObject({ proxyQuality: "standard", organize: "ai", timeline: true, upload: "none", finalsUpload: "all" });
    expect(s.proxy).not.toBe(true); // the card sends no proxy answer: proxies are never turned on unasked
    expect(Date.parse(s.setupAt)).toBeGreaterThan(0);
    expect((await p.message(m.id))!.action).toBeUndefined();
    expect(told).toContain("eve:assistant");
    await job;
    expect((await p.view()).messages.slice(-2)).toMatchObject([{ role: "user", text: "import my clips" }, { role: "assistant", status: "thinking" }]);
  });

  it("quick_setup on a computer that is not reachable is a 409 with the computer's line", async () => {
    const p = await person("fay");
    const off = pairDevice("fay", "Fay's Mini").device.id;
    const lib = (await ensureLibrary("fay"))!;
    const r = await app.request(`/api/library/${lib}/setup/quick`, { method: "POST", headers: { ...p.phone, "content-type": "application/json" }, body: JSON.stringify({ device: off }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: cantFind("Fay's Mini") });
  });
});

describe("browse a computer's folders", () => {
  const browse = (headers: Record<string, string>, device: string, p: string) => app.request(`/api/devices/${device}/browse?path=${encodeURIComponent(p)}`, { headers });

  it("asks the computer, which answers ~ with its home's full path", async () => {
    const p = await person("gus");
    const dev = { authorization: `Bearer ${p.token}`, "content-type": "application/json" };
    const claim = () => app.request("/api/devices/relay/editor/claim", { method: "POST", headers: dev, body: JSON.stringify({ kinds: ["folder-browse"] }) });
    await claim(); // the app says what it takes
    const asked = browse(p.phone, p.mac, "~");
    let job: { id: number; options: Record<string, string> } | null = null;
    for (let i = 0; i < 50 && !job; i++) job = ((await (await claim()).json()) as { job: typeof job }).job ?? (await tick(), null);
    expect(job!.options).toEqual({ path: "~" });
    const answer = { path: "/Users/gus", parent: null, roots: [{ name: "Home", path: "/Users/gus" }, { name: "Footage", path: "/Volumes/Footage" }], dirs: [{ name: "Movies", path: "/Users/gus/Movies" }] };
    expect((await app.request(`/api/devices/relay/job/folder-browse/${job!.id}`, { method: "POST", headers: dev, body: JSON.stringify(answer) })).status).toBe(200);
    const r = await asked;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ device: p.mac, deviceName: "gus's Mac", ...answer });
  });

  it("refuses another account's computer, a path outside home and drives, a computer offline and an app too old", async () => {
    const p = await person("hal");
    const q = await person("ivy");
    expect((await browse(p.phone, q.mac, "~")).status).toBe(404);
    const outside = await browse(p.phone, p.mac, "/etc");
    expect(outside.status).toBe(400);
    expect(await outside.json()).toEqual({ error: "Only folders in your home folder or on your drives" });
    expect((await browse(p.phone, p.mac, "/Volumes/../etc")).status).toBe(400);
    const old = await browse(p.phone, p.mac, "~");   // online, but its app never said it takes folder-browse
    expect(old.status).toBe(501);
    expect(await old.json()).toEqual({ error: "Update Creator Toolset on hal's Mac to choose a folder from here", code: "update_needed" });
    const off = pairDevice("hal", "Hal's Mini").device.id;
    const gone = await browse(p.phone, off, "~");
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: cantFind("Hal's Mini"), code: "computer_offline" });
  });
});

describe("the iPhone app's own session", () => {
  it("reaches every route a card's call or browse sends (a Bearer client session of a phone, read and write)", async () => {
    const p = await person("jon");
    const { issueSession } = await import("./lib/clients");
    const { token } = issueSession({ subject: "jon", scopes: ["read", "write"], client: { deviceType: "mobile" } });
    const lib = (await ensureLibrary("jon"))!;
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const at = async (method: string, url: string, body?: unknown) => (await app.request(url, { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) })).status;
    // each answers as the route itself would, never the session gate's 401 or 403
    expect(await at("GET", `/api/devices/${p.mac}/browse?path=~`)).toBe(501);   // its app never said it takes folder-browse
    expect(await at("GET", "/api/assistant/action/no-such-message")).toBe(404);
    expect(await at("PUT", "/api/library/offline/downloads", { library: lib, mode: "needed" })).toBe(200);
    expect(await at("POST", "/api/devices/storage/folders", { role: "projects", host: p.mac, path: "~/Movies/Creator Toolset/Jon/Project files", make: true })).toBe(200);
    expect(await at("POST", `/api/library/${lib}/setup/quick`, { device: p.mac })).toBe(200);
  });

  /** A phone's client session of `name` with these scopes, and a request as it: the status and the answer's code. */
  const asPhone = async (name: string, scopes: ("read" | "write")[]) => {
    const { issueSession } = await import("./lib/clients");
    const { token } = issueSession({ subject: name, scopes, client: { deviceType: "mobile" } });
    return async (method: string, url: string, body?: unknown) => {
      const r = await app.request(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, code: ((await r.json().catch(() => ({}))) as { code?: string }).code };
    };
  };

  it("with write, it reaches the card's two computer routes and nothing else under /api/devices or /api/admin", async () => {
    const p = await person("kim");
    const at = await asPhone("kim", ["read", "write"]);
    expect((await at("GET", `/api/devices/${p.mac}/browse?path=~`)).status).toBe(501);   // the route's own answer: its app is too old
    expect((await at("POST", "/api/devices/storage/folders", { role: "projects", host: p.mac, path: "~/Movies/Creator Toolset/Kim/Project files" })).status).toBe(200);
    for (const [method, url] of [["GET", "/api/devices"], ["POST", "/api/devices/storage/folders/no-such-folder/re-point"], ["GET", "/api/admin/users"], ["GET", `/api/devices/${p.mac}/browse/more`], ["POST", "/api/devices/storage/folders/"]] as const)
      expect(await at(method, url, method === "POST" ? { path: "/Volumes/X" } : undefined), `${method} ${url}`).toEqual({ status: 403, code: "NOT_FOR_CLIENTS" });
  });

  it("without write, both card routes are refused", async () => {
    const p = await person("lou");
    const at = await asPhone("lou", ["read"]);
    expect(await at("GET", `/api/devices/${p.mac}/browse?path=~`)).toEqual({ status: 403, code: "SCOPE" });
    expect(await at("POST", "/api/devices/storage/folders", { role: "projects", host: p.mac, path: "~/Movies/Creator Toolset/Lou/Project files" })).toEqual({ status: 403, code: "SCOPE" });
  });

  it("another account's computer: browse is 404 and a folder on it is refused", async () => {
    await person("max");
    const other = await person("ned");
    const at = await asPhone("max", ["read", "write"]);
    expect((await at("GET", `/api/devices/${other.mac}/browse?path=~`)).status).toBe(404);
    expect((await at("POST", "/api/devices/storage/folders", { role: "projects", host: other.mac, path: "~/Movies/Creator Toolset/Ned/Project files" })).status).toBe(400);
    expect((await storageOf("max")).folders).toEqual([]);
  });
});
