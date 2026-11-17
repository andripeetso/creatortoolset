// Which workspaces each installed plug-in works in: the defaults (a new one that works by itself starts off everywhere,
// one already installed stays on where its account works today, any other is on everywhere), a plug-in that changes the
// whole server staying on everywhere, the settings page's list, and a route or tool in a workspace where it is off.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? process.env.TMPDIR ?? tmpdir(), "plugin-workspaces-"));
const dir = process.env.DATA_DIR;

const { choiceOf, guardPlugins, pluginGuard, serverWide, pluginOnIn, pluginsOffIn, pluginWorkspacesApp, setPluginsForTest } = await import("./plugin-workspaces");
const { mountPlugins } = await import("./plugin");
const { inRequestWorkspace } = await import("./workspace-scope");
const { default: faceBlur } = await import("../../editor-steps/blur-faces/plugin");
type P = import("./plugin").ServerPlugin;

const byItself = (id: string): P => ({ id, name: id, start: () => {} });
// a plug-in that runs part of the server: it replaces the AI Editor's routes, with its own checks
const studio: P = { id: "studio", name: "Studio", replaces: { paths: ["/api/editor"], routes: new Hono() }, editFlags: [{ id: "children", label: "Contains children" }] };
const echo = new Hono().get("/", (c) => c.json({ ok: true }));
const plain: P = {
  id: "tiny-echo",
  name: "Tiny Echo",
  gates: { ids: ["tiny-echo" as never] },
  routes: echo,
  tools: {
    defs: [{ name: "tiny_echo", description: "Echo a line for the Tiny Acrobatics test plug-in.", inputSchema: { type: "object", properties: {} } }],
    handlers: { tiny_echo: async () => ({ ran: true }) },
  },
};
// shaped like a cleaner plug-in: a gate and routes of its own outside /api/x (gatedRoutes)
const cleanApp = new Hono().get("/", (c) => c.json({ ok: true }));
const cleaner: P = { id: "tiny-cleaner", name: "Tiny Cleaner", gates: { ids: ["clean" as never] }, gatedRoutes: [{ path: "/api/tiny-clean", app: cleanApp }] };
const old = byItself("old-helper");
const fresh = byItself("new-helper");

const ana = { username: "ana", role: "user" as const, off: [] as string[] };
const app = new Hono<{ Variables: { user: unknown } }>();
app.use(async (c, next) => {
  c.set("user", ana);
  await next();
});
app.use("/api/*", inRequestWorkspace);

beforeAll(async () => {
  const projects = path.join(dir, "workshop", "projects");
  mkdirSync(projects, { recursive: true });
  for (const [id, name, createdAt] of [["ws-tiny", "Tiny Acrobatics", 1], ["ws-homes", "Tiny Homes", 2]] as const)
    writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name, createdAt, updatedAt: createdAt }));
  mkdirSync(path.join(dir, "workshop", "users"), { recursive: true });
  writeFileSync(path.join(dir, "workshop", "users", "ana.json"), JSON.stringify({ currentProjectId: "ws-tiny" }));
  // the first boot with this: the plug-ins loaded then are the ones installed before (fresh comes later)
  guardPlugins(app, [studio, plain, old, cleaner]);
  await setPluginsForTest([studio, plain, old, fresh, cleaner, faceBlur]);
  mountPlugins(app, [plain, faceBlur], pluginGuard);
  app.route("/api/tiny-clean", cleanApp);
  app.route("/api/plugins", pluginWorkspacesApp);
});

const put = (id: string, body: unknown) => app.request(`/api/plugins/${id}/workspaces`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("the defaults", () => {
  it("a newly installed plug-in that works by itself is off in every workspace", async () => {
    expect(await choiceOf(fresh, "ana")).toEqual({ only: [] });
    expect(await pluginOnIn(fresh, "ana", "ws-tiny")).toBe(false);
    expect(await pluginOnIn(fresh, "ana", "ws-homes")).toBe(false);
  });

  it("one installed before stays on only in the workspace the account works in today, and that is written down", async () => {
    expect(await pluginOnIn(old, "ana", "ws-tiny")).toBe(true);
    expect(await pluginOnIn(old, "ana", "ws-homes")).toBe(false);
    // switching workspace afterwards changes nothing: the choice was saved
    writeFileSync(path.join(dir, "workshop", "users", "ana.json"), JSON.stringify({ currentProjectId: "ws-homes" }));
    expect(await choiceOf(old, "ana")).toEqual({ only: ["ws-tiny"] });
    writeFileSync(path.join(dir, "workshop", "users", "ana.json"), JSON.stringify({ currentProjectId: "ws-tiny" }));
  });

  it("any other plug-in stays on in every workspace, so nothing disappears unasked", async () => {
    expect(await choiceOf(plain, "ana")).toEqual({ all: true });
    // an account with no workspace keeps nothing apart
    expect(await pluginOnIn(fresh, "bo", undefined)).toBe(true);
  });
});

describe("a plug-in that changes the whole server", () => {
  it("is on in every workspace and can't be turned off in one, so its own checks always run there", async () => {
    const r = await put("studio", { only: [] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/every workspace/);
    for (const ws of ["ws-tiny", "ws-homes"]) expect(await pluginOnIn(studio, "ana", ws)).toBe(true);
    expect(Object.values(await pluginsOffIn([{ id: "ws-tiny", owner: "ana" }, { id: "ws-homes", owner: "ana" }])).flat()).not.toContain("studio");
    const view = (await (await app.request("/api/plugins/studio/workspaces")).json()) as { fixed?: string; all: boolean };
    expect(view.fixed).toBe("It runs this server's Editor, so it is on in every workspace");
    expect(view.all).toBe(true);
  });
});

describe("the settings page", () => {
  it("lists the account's workspaces, each on or off, and saves a choice of some", async () => {
    expect(await (await app.request("/api/plugins/old-helper/workspaces")).json()).toEqual({
      id: "old-helper",
      name: "old-helper",
      all: false,
      workspaces: expect.arrayContaining([{ id: "ws-tiny", name: "Tiny Acrobatics", on: true }, { id: "ws-homes", name: "Tiny Homes", on: false }]),
    });
    expect((await put("old-helper", { only: ["ws-elsewhere"] })).status).toBe(400); // not one of hers
    expect(((await (await put("old-helper", { all: true })).json()) as { all: boolean }).all).toBe(true);
    expect(await pluginOnIn(old, "ana", "ws-homes")).toBe(true);
  });
});

describe("in a workspace where it is off", () => {
  it("its routes and its tools say it is off there and where to turn it on; its gate is hidden there", async () => {
    expect((await app.request("/api/x/tiny-echo")).status).toBe(200);
    await put("tiny-echo", { only: ["ws-homes"] });
    const r = await app.request("/api/x/tiny-echo");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/Tiny Echo is off in the workspace Tiny Acrobatics\. Turn it on .*Settings/);
    expect((await pluginsOffIn([{ id: "ws-tiny", owner: "ana" }]))["ws-tiny"]).toEqual(expect.arrayContaining(["tiny-echo"]));

    const { handle, pluginToolsOf } = await import("../mcp");
    const plugged = pluginToolsOf([plain]);
    const res = (await handle(
      async () => new Response("{}"),
      new Headers(),
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tiny_echo", arguments: {} } },
      "https://tools.example.com",
      ana as never,
      plugged,
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).toMatch(/Tiny Echo is off in the workspace Tiny Acrobatics/);
  });
});

describe("per workspace, one on and one off", () => {
  const inWs = (url: string, ws: string) => app.request(url, { headers: { "X-CT-Workspace": ws } });
  it("Face Blur gets the real switch: off in Tiny Homes it says so there, and works in Tiny Acrobatics", async () => {
    expect(serverWide(faceBlur)).toBe(false);
    expect((await put("blur-faces", { only: ["ws-tiny"] })).status).toBe(200);
    expect((await inWs("/api/x/blur-faces/example", "ws-tiny")).status).toBe(200);
    const off = await inWs("/api/x/blur-faces/example", "ws-homes");
    expect(off.status).toBe(403);
    expect(((await off.json()) as { error: string }).error).toMatch(/^Face Blur is off in the workspace Tiny Homes\./);
  });

  it("a plug-in with routes of its own outside /api/x (a cleaner) does the same", async () => {
    expect(serverWide(cleaner)).toBe(false);
    expect((await inWs("/api/tiny-clean", "ws-homes")).status).toBe(200); // all workspaces until a choice is made
    await put("tiny-cleaner", { only: ["ws-tiny"] });
    expect((await inWs("/api/tiny-clean", "ws-tiny")).status).toBe(200);
    expect((await inWs("/api/tiny-clean", "ws-homes")).status).toBe(403);
    expect((await pluginsOffIn([{ id: "ws-homes", owner: "ana" }]))["ws-homes"]).toEqual(expect.arrayContaining(["tiny-cleaner", "clean"]));
  });
});
