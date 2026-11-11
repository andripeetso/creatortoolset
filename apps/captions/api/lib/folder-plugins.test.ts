import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { definePlugin, type ServerPlugin } from "./plugin";

// The app's own modules a test plug-in asks for, as the Mac build's host list gives them (api/plugin-host.gen.ts).
vi.mock("../plugin-host.gen", () => ({
  hostModules: { "api/lib/plugin": () => import("./plugin"), "pkg:hono": () => import("hono") } as Record<string, () => Promise<unknown>>,
}));

const { blamedPlugin, fingerprintOf, folderPluginRows, loadFolderPlugins, mountFolderPlugins, parseFolders, parseOn, pluginLimits, prepareFolderPlugin, resetFolderPluginsForTest, startFolderPlugin } =
  await import("./folder-plugins");

// A throwaway app folder under node_modules/.tmp (git-ignored, on the same disk as the build).
let root: string;
const saved = { ...process.env };
const write = (folder: string, file: string, text: string) => {
  mkdirSync(path.join(root, "plugins", folder), { recursive: true });
  writeFileSync(path.join(root, "plugins", folder, file), text);
};
const server = (id: string, body = "") =>
  `import { Hono } from "hono";\nimport { definePlugin } from "../../api/lib/plugin";\nconst app = new Hono();\napp.get("/ping", (c) => c.json({ ok: "${id}" }));\n${body}\nexport default definePlugin({ id: "${id}", name: "Name of ${id}", about: "About ${id}.", routes: app });\n`;
/** Switch on, as the Mac app does it: prepare, then the id and fingerprint in CT_PLUGINS_ON for the next start. */
const switchOn = async (...folders: string[]) => {
  const pairs = [];
  for (const f of folders) {
    const p = await prepareFolderPlugin(f);
    pairs.push(`${p.id}:${p.fingerprint}`);
  }
  process.env.CT_PLUGINS_ON = [process.env.CT_PLUGINS_ON, ...pairs].filter(Boolean).join(",");
};
const start = (compiled: ServerPlugin[] = []) => {
  resetFolderPluginsForTest();
  return loadFolderPlugins(compiled);
};
const row = (id: string) => folderPluginRows().find((r) => r.id === id)!;

beforeEach(() => {
  // a space in the path, as every real install has ("Application Support")
  root = path.join(process.cwd(), "node_modules", ".tmp", `folder plugins ${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  Object.assign(process.env, { CT_LOCAL: "1", CT_APP_FOLDER: root });
  delete process.env.CT_PLUGINS_ON;
  delete process.env.CT_PLUGINS_PAUSED;
});
const limits = { ...pluginLimits };
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.env = { ...saved };
  Object.assign(pluginLimits, limits);
});

describe("plug-ins from the person's folder", () => {
  // each of these has a plug-in that IS switched on: with the guard taken out, it would load
  it("loads nothing off the Mac app's own server, even for a plug-in that is switched on", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    delete process.env.CT_LOCAL;
    expect(await start()).toEqual([]);
    process.env.CT_LOCAL = "1";
    delete process.env.CT_APP_FOLDER;
    expect(await start()).toEqual([]);
    process.env.CT_APP_FOLDER = root;
    expect((await start()).map((p) => p.id)).toEqual(["a"]);
  });

  it("loads nothing on a hosted server, whatever its variables say", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    process.env.CT_MODE = "hosted";
    expect(await start()).toEqual([]);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user" as never, { role: "admin" } as never);
      await next();
    });
    mountFolderPlugins(app);
    expect(await (await app.request("/api/plugins/folder")).json()).toMatchObject({ enabled: false, rows: [] });
    expect((await app.request("/api/plugins/folder/a/prepare", { method: "POST" })).status).toBe(403);
  });

  it("gives an admin no list and no Switch on off the Mac app's own server", async () => {
    write("a", "plugin.ts", server("a"));
    delete process.env.CT_LOCAL;
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user" as never, { role: "admin" } as never);
      await next();
    });
    mountFolderPlugins(app);
    expect(await (await app.request("/api/plugins/folder")).json()).toMatchObject({ enabled: false, rows: [] });
    expect((await app.request("/api/plugins/folder/a/prepare", { method: "POST" })).status).toBe(403);
    expect(existsSync(path.join(root, "plugins-approved"))).toBe(false);
  });

  it("leaves hidden files and node_modules out of the fingerprint and out of the copy", async () => {
    write("a", "plugin.ts", server("a"));
    const plain = (await prepareFolderPlugin("a")).fingerprint;
    write("a", ".env", "SECRET=1");
    mkdirSync(path.join(root, "plugins", "a", ".git"), { recursive: true });
    writeFileSync(path.join(root, "plugins", "a", ".git", "config"), "x");
    mkdirSync(path.join(root, "plugins", "a", "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "plugins", "a", "node_modules", "pkg", "index.js"), "x");
    const again = await prepareFolderPlugin("a");
    expect(again.fingerprint).toBe(plain);
    const copy = path.join(root, "plugins-approved", "a", plain);
    expect(existsSync(path.join(copy, "plugin.ts"))).toBe(true);
    for (const left of [".env", ".git", "node_modules"]) expect(existsSync(path.join(copy, left))).toBe(false);
  });

  it("refuses a folder over the size cap without reading it, on the list and at Switch on", async () => {
    write("big", "plugin.ts", server("big"));
    // 21 MB that takes no room on the disk: the size is asked, the file is not read
    write("big", "footage.bin", "");
    truncateSync(path.join(root, "plugins", "big", "footage.bin"), 21 * 1024 * 1024);
    expect(folderPluginRows().find((r) => r.folder === "big")).toMatchObject({ id: null, on: false, error: "The folder is too big for a plug-in (over 2,000 files or 20 MB)" });
    await expect(prepareFolderPlugin("big")).rejects.toThrow(/too big for a plug-in/);
    // hidden, it does not count
    renameSync(path.join(root, "plugins", "big", "footage.bin"), path.join(root, "plugins", "big", ".footage.bin"));
    expect((await prepareFolderPlugin("big")).id).toBe("big");
  });

  it("does not take a link to a folder somewhere else as a plug-in", async () => {
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, "plugin.ts"), server("linked"));
    mkdirSync(path.join(root, "plugins"), { recursive: true });
    symlinkSync(elsewhere, path.join(root, "plugins", "linked"));
    expect(folderPluginRows()).toEqual([]);
    await expect(prepareFolderPlugin("linked")).rejects.toThrow(/not a link to one/);
  });

  it("refuses an approved copy whose files state another id than the one switched on", async () => {
    const text = server("y");
    const fingerprint = fingerprintOf(new Map([["plugin.ts", Buffer.from(text)]]));
    mkdirSync(path.join(root, "plugins-approved", "x", fingerprint), { recursive: true });
    writeFileSync(path.join(root, "plugins-approved", "x", fingerprint, "plugin.ts"), text);
    process.env.CT_PLUGINS_ON = `x:${fingerprint}`;
    expect(await start()).toEqual([]);
    expect(folderPluginRows().find((r) => r.id === "x")).toMatchObject({ on: true, running: false, error: "Its files say its id is y" });
  });

  it("refuses a plug-in that loads under another id than its files state", async () => {
    // the id the builder reads from the text is the first one written; the one that runs is another
    write("decoy", "plugin.ts", `import { definePlugin } from "../../api/lib/plugin";\n// id: "decoy"\nconst real = "real";\nexport default definePlugin({ id: real, name: "Two names" });\n`);
    await switchOn("decoy");
    expect(process.env.CT_PLUGINS_ON).toMatch(/^decoy:/);
    expect(await start()).toEqual([]);
    expect(row("decoy")).toMatchObject({ on: true, running: false, error: "plugin.ts loaded as real" });
  });

  it("leaves out and names a plug-in that takes too long to build, and Switch on refuses it", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    pluginLimits.buildMs = 1;
    expect(await start()).toEqual([]);
    expect(row("a").error).toBe("It takes too long to build, so the app would start without it");
    await expect(prepareFolderPlugin("a")).rejects.toThrow(/takes too long to build/);
  });

  it("leaves out and names a plug-in whose file never finishes loading, and does not try it at every start", async () => {
    write("stuck", "plugin.ts", server("stuck", "await new Promise(() => {});"));
    write("ok", "plugin.ts", server("ok"));
    await switchOn("ok", "stuck");
    pluginLimits.loadMs = 150;
    expect((await start()).map((p) => p.id)).toEqual(["ok"]);
    expect(row("stuck").error).toBe("It took too long to load");
    // the next start, with the usual limit: it is skipped at once, not waited for again
    Object.assign(pluginLimits, limits);
    const began = Date.now();
    expect((await start()).map((p) => p.id)).toEqual(["ok"]);
    expect(Date.now() - began).toBeLessThan(limits.loadMs);
    expect(row("stuck").error).toBe("It took too long to load"); // the same words at every start
  });

  it("stops loading when the whole start's time is used up, and says so", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    pluginLimits.budgetMs = 0;
    expect(await start()).toEqual([]);
    expect(row("a").error).toBe("The app's start ran out of time before it was loaded");
  });

  it("runs nothing that was not switched on", async () => {
    write("a", "plugin.ts", server("a"));
    expect(await start()).toEqual([]);
    expect(row("a")).toMatchObject({ folder: "a", name: "Name of a", about: "About a.", on: false, running: false, changed: false });
  });

  it("loads a plug-in that was switched on, and its routes answer", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    const [plugin] = await start();
    expect(plugin!.id).toBe("a");
    expect(await (await (plugin!.routes as Hono).request("/ping")).json()).toEqual({ ok: "a" });
    expect(row("a")).toMatchObject({ on: true, running: true, changed: false });
  });

  it("keeps running the approved copy when the folder changes, and says it changed", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    write("a", "plugin.ts", server("a").replace('ok: "a"', 'ok: "edited"'));
    const [plugin] = await start();
    expect(await (await (plugin!.routes as Hono).request("/ping")).json()).toEqual({ ok: "a" });
    expect(row("a")).toMatchObject({ running: true, changed: true });
  });

  it("keeps a plug-in that is on with the folder it was switched on from, whatever another folder says its id is", async () => {
    write("tiny", "plugin.ts", server("tiny"));
    await switchOn("tiny");
    process.env.CT_PLUGINS_FOLDERS = JSON.stringify({ tiny: "tiny" });
    // a folder nobody switched on, sorted first, stating the same id with other code
    write("aaa", "plugin.ts", server("tiny").replace('ok: "tiny"', 'ok: "not mine"'));
    const [plugin] = await start();
    expect(await (await (plugin!.routes as Hono).request("/ping")).json()).toEqual({ ok: "tiny" });
    const rows = folderPluginRows();
    expect(rows.find((r) => r.folder === "tiny")).toMatchObject({ id: "tiny", on: true, running: true, changed: false });
    expect(rows.find((r) => r.folder === "aaa")).toMatchObject({ id: null, on: false, changed: false, error: "Another folder is already the plug-in tiny" });
    // the folder it was switched on from is renamed: the renamed one is the plug-in, still on
    rmSync(path.join(root, "plugins", "aaa"), { recursive: true });
    renameSync(path.join(root, "plugins", "tiny"), path.join(root, "plugins", "tiny 2"));
    expect(folderPluginRows()).toMatchObject([{ folder: "tiny 2", id: "tiny", on: true, running: true, changed: false }]);
    expect(parseFolders('{"a":"my, folder","b":3}')).toEqual(new Map([["a", "my, folder"]]));
    expect(parseFolders("not json")).toEqual(new Map());
    expect(parseFolders(undefined)).toEqual(new Map());
  });

  it("refuses an approved copy that was edited afterwards", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    const [id, fingerprint] = process.env.CT_PLUGINS_ON!.split(":");
    writeFileSync(path.join(root, "plugins-approved", id!, fingerprint!, "plugin.ts"), server("a", "console.log('added')"));
    expect(await start()).toEqual([]);
    expect(row("a").error).toMatch(/changed outside the app/);
  });

  it("refuses a fingerprint nobody approved", async () => {
    write("a", "plugin.ts", server("a"));
    process.env.CT_PLUGINS_ON = `a:${"0".repeat(64)}`;
    expect(await start()).toEqual([]);
    expect(row("a")).toMatchObject({ on: true, running: false });
  });

  it("loads the good one and names the bad one", async () => {
    write("good", "plugin.ts", server("good"));
    write("throws", "plugin.ts", server("throws", 'throw new Error("boom at load");'));
    await switchOn("good", "throws");
    expect((await start()).map((p) => p.id)).toEqual(["good"]);
    expect(row("throws")).toMatchObject({ on: true, running: false, error: "boom at load" });
    expect(row("good").error).toBeUndefined();
  });

  it("says why a plug-in doesn't build, and switches nothing on", async () => {
    write("bad", "plugin.ts", `import { definePlugin } from "../../api/lib/plugin";\nimport x from "left-pad";\nexport default definePlugin({ id: "bad", about: String(x) });\n`);
    await expect(prepareFolderPlugin("bad")).rejects.toThrow(/left-pad.*doesn't use this package/);
    expect(existsSync(path.join(root, "plugins-approved", "bad"))).toBe(false);
  });

  it("names a module this version of the app doesn't have", async () => {
    write("a", "plugin.ts", `import { definePlugin } from "../../api/lib/plugin";\nimport { env } from "../../api/lib/env";\nexport default definePlugin({ id: "a", about: String(!!env) });\n`);
    await switchOn("a");
    expect(await start()).toEqual([]);
    expect(row("a").error).toBe("It needs api/lib/env, which this version of the app doesn't have");
  });

  // every check that stops the whole server for a compiled-in plug-in leaves a folder plug-in out instead
  const collisions: [string, string, ServerPlugin | null, RegExp][] = [
    ["an id the app has", "", definePlugin({ id: "x" }), /already has a plug-in called x/],
    ["a gate another plug-in has", 'gates: { ids: ["shared"] }', definePlugin({ id: "first", gates: { ids: ["shared"] } }), /gate "shared"/],
    ["a gate that is a built-in app", 'gates: { ids: ["media"] }', null, /not a gate id/],
    ["an edit flag declared twice", 'editFlags: [{ id: "flag", label: "Flag" }]', definePlugin({ id: "first", editFlags: [{ id: "flag", label: "Flag" }] as never }), /edit flag "flag"/],
    ["a provider kind that is a driver", 'providers: { kinds: [{ id: "claude", label: "X" }] }', null, /already a driver|provider kind/],
    ["an upload relay that is built in", 'uploadRelays: [{ id: "chunked", label: "X" }]', null, /upload relay "chunked"/],
    ["a pack item kind the app doesn't know", 'packItems: [{ kind: "nope" }]', null, /not a pack item kind/],
    ["a path that can't be replaced", 'replaces: { paths: ["/api/review"], routes: new Hono() }', null, /not a replaceable path/],
    ["a path that can't be answered", 'answers: [{ path: "/api/nope", routes: new Hono() }]', null, /not an answerable path/],
    ["a public route without its slash", 'publicRoutes: [{ path: "nope", app: new Hono() }]', null, /must start with \//],
    // ahead of the sign-in = open to the whole network once other devices are on
    ["a public route", 'publicRoutes: [{ path: "/hook", app: new Hono() }]', null, /answers before the sign-in/],
    ["open routes", 'openRoutes: new Hono().post("/hook", (c) => c.text("ok"))', null, /answers before the sign-in/],
    ["routes that are not a Hono app", "routes: { nope: true }", null, /./],
    ["a start that is not a function", 'start: "soon"', null, /start must be a function/],
    // these two passed the check and then stopped the whole server when it mounted them
    ["open routes that already serve its own path", 'routes: new Hono(), openRoutes: new Hono().post("/api/x/x/webhook", (c) => c.text("ok"))', null, /\/api\/x\/x is already served by open or public routes/],
    ["a second public-grid reader", "connectors: { publicGrid: async () => ({}) }", definePlugin({ id: "first", connectors: { publicGrid: (async () => ({})) as never } }), /plug-in first already reads public grids/],
    ["a Media Library filter another plug-in has", 'library: { facets: [{ key: "who", where: () => ({ sql: "1", params: [] }) }] }', definePlugin({ id: "first", library: { facets: [{ key: "who", where: () => ({ sql: "1", params: [] }) }] } }), /library facet "who" is already registered/],
    ["a Media Library policy for a source nobody has", 'library: { policies: [{ sourceId: "nowhere", canSee: () => true }] }', null, /library policy for unknown source "nowhere"/],
    ["large bodies that are not regular expressions", 'replaces: { paths: ["/api/editor"], routes: new Hono(), largeBodies: ["/api/editor"] }', null, /largeBodies must be regular expressions/],
  ];
  it.each(collisions)("leaves out a plug-in with %s", async (_what, field, first, why) => {
    write("x", "plugin.ts", `import { Hono } from "hono";\nimport { definePlugin } from "../../api/lib/plugin";\nexport default definePlugin({ id: "x", ${field} } as never);\nexport const keep = Hono;\n`);
    write("ok", "plugin.ts", server("ok"));
    await switchOn("x", "ok");
    expect((await start(first ? [first] : [])).map((p) => p.id)).toEqual(["ok"]);
    expect(row("x").error).toMatch(why);
  });

  it("leaves out a plug-in whose AI tool the app already serves", async () => {
    write("x", "plugin.ts", server("x"));
    await switchOn("x");
    resetFolderPluginsForTest();
    const refuse = (all: ServerPlugin[]) => {
      if (all.some((p) => p.id === "x")) throw new Error("plug-in x: tool find is already served");
    };
    expect(await loadFolderPlugins([], refuse)).toEqual([]);
    expect(row("x").error).toBe("plug-in x: tool find is already served");
  });

  it("skips a plug-in that was loading when the server died, until it is switched off or approved again", async () => {
    write("a", "plugin.ts", server("a"));
    write("b", "plugin.ts", server("b"));
    await switchOn("a", "b");
    const on = parseOn(process.env.CT_PLUGINS_ON);
    writeFileSync(path.join(root, "plugins-state.json"), JSON.stringify({ loading: { id: "a", fingerprint: on.get("a") }, stopped: {} }));
    expect((await start()).map((p) => p.id)).toEqual(["b"]);
    expect(row("a").error).toBe("It stopped the app's server while starting.");
    // the next start remembers it
    expect((await start()).map((p) => p.id)).toEqual(["b"]);
    // a new version, approved: it gets its chance
    write("a", "plugin.ts", server("a", "// fixed"));
    process.env.CT_PLUGINS_ON = `b:${on.get("b")}`;
    await switchOn("a");
    expect((await start()).map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("goes on when a start hook throws, and names the plug-in", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    const [plugin] = await start();
    startFolderPlugin(plugin!, () => {
      throw new Error("no such table");
    });
    expect(row("a").error).toBe("Its start failed: no such table");
    expect(JSON.parse(readFileSync(path.join(root, "plugins-state.json"), "utf8")).loading).toBeNull();
    // a compiled-in plug-in's hook still fails loudly
    expect(() => startFolderPlugin(definePlugin({ id: "compiled" }), () => { throw new Error("loud"); })).toThrow("loud");
  });

  it("counts a body-limit hook that throws as no, on every request, and names the plug-in", async () => {
    write("a", "plugin.ts", server("a").replace('routes: app', 'routes: app, bodyLimitExempt: () => { throw new Error("bad pattern"); }'));
    await switchOn("a");
    const [plugin] = await start();
    expect(plugin!.bodyLimitExempt!("POST", "/api/x/a/upload")).toBe(false);
    expect(row("a")).toMatchObject({ running: true, error: "Its bodyLimitExempt failed: bad pattern" });
  });

  it("loads nothing while plug-ins are paused, and still lists what is on", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    process.env.CT_PLUGINS_PAUSED = "1";
    expect(await start()).toEqual([]);
    expect(row("a")).toMatchObject({ on: true, running: false });
  });

  it("serves a page half only from the approved copy, to the page", async () => {
    write("a", "web.tsx", `import { defineWebPlugin } from "../../src/lib/plugin";\nexport default defineWebPlugin({ id: "a", name: "A page", routes: [{ path: "/a-page", element: <p className="p-[37px]">hi</p> }] });\n`);
    await switchOn("a");
    expect(await start()).toEqual([]);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user" as never, { role: "admin" } as never);
      await next();
    });
    mountFolderPlugins(app);
    const list = (await (await app.request("/api/plugins/web")).json()) as { plugins: { id: string; needs: string[]; css: boolean }[] };
    expect(list.plugins).toMatchObject([{ id: "a", name: "A page", css: true }]);
    expect(list.plugins[0]!.needs).toEqual(expect.arrayContaining(["src/lib/plugin", "pkg:react/jsx-runtime"]));
    expect(await (await app.request("/api/plugins/web/a/web.css")).text()).toContain("37px");
    expect((await app.request("/api/plugins/web/a/web.js")).headers.get("content-type")).toContain("javascript");
    expect((await app.request("/api/plugins/web/nope/web.js")).status).toBe(404);
    const rows = (await (await app.request("/api/plugins/folder")).json()) as { enabled: boolean; rows: { id: string }[] };
    expect(rows.enabled).toBe(true);
    expect(rows.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("gives the list and Switch on only to an admin", async () => {
    write("a", "plugin.ts", server("a"));
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user" as never, { role: "user" } as never);
      await next();
    });
    mountFolderPlugins(app);
    expect(await (await app.request("/api/plugins/folder")).json()).toMatchObject({ enabled: false, rows: [] });
    expect((await app.request("/api/plugins/folder/a/prepare", { method: "POST" })).status).toBe(403);
  });

  it("reads a fingerprint from every path and byte", () => {
    const a = fingerprintOf(new Map([["plugin.ts", Buffer.from("x")]]));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintOf(new Map([["plugin.ts", Buffer.from("y")]]))).not.toBe(a);
    expect(fingerprintOf(new Map([["web.tsx", Buffer.from("x")]]))).not.toBe(a);
  });

  it("drops a malformed entry from the Mac app's list", () => {
    expect([...parseOn(`a:${"f".repeat(64)}, b:short, ../x:${"f".repeat(64)}`).keys()]).toEqual(["a"]);
  });

  it("finds the plug-in whose file is in a crash's stack", () => {
    expect(blamedPlugin("Error: x\n    at f (/app/plugins-run/sponsors/out/server.js:3:1)", "/app/plugins-run")).toBe("sponsors");
    expect(blamedPlugin("Error: x\n    at f (/app/dist/boot.js:3:1)", "/app/plugins-run")).toBeNull();
    // an imported module is named by its file: address, where the space of "Application Support" is %20
    const run = "/Users/t/Library/Application Support/Creator Toolset/plugins-run";
    expect(blamedPlugin("Error: x\n    at f (file:///Users/t/Library/Application%20Support/Creator%20Toolset/plugins-run/sponsors/out/server.js:3:1)", run)).toBe("sponsors");
  });

  it("finds the plug-in in the real stack of an error it throws later, from a folder with a space in its path", async () => {
    expect(root).toContain(" ");
    write("late", "plugin.ts", server("late").replace("routes: app", 'routes: app, activity: () => { throw new Error("later"); }'));
    await switchOn("late");
    const [plugin] = await start();
    let stack = "";
    try {
      (plugin!.activity as unknown as () => void)();
    } catch (e) {
      stack = (e as Error).stack ?? "";
    }
    expect(stack).toContain("later");
    expect(blamedPlugin(stack)).toBe("late");
  });

  // an install that never used plug-ins runs this loader too: nothing in it may stop the app's start
  it("starts the app with no plug-ins when its notes can't be written, with nothing switched on and with one on", async () => {
    mkdirSync(path.join(root, "plugins-state.json")); // a folder where the notes file goes: every write fails
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await start()).toEqual([]);
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    expect(await start()).toEqual([]);
    expect(row("a")).toMatchObject({ on: true, running: false, error: "The app's folder can't be written, so it was not loaded" });
    process.env.CT_PLUGINS_PAUSED = "1";
    expect(await start()).toEqual([]);
    quiet.mockRestore();
  });

  it("starts the app with no plug-ins when the app's folder is read-only", async () => {
    write("a", "plugin.ts", server("a"));
    await switchOn("a");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(root, 0o555);
    try {
      expect(await start()).toEqual([]);
      expect(row("a")).toMatchObject({ on: true, running: false });
      expect(row("a").error).toBeTruthy();
    } finally {
      chmodSync(root, 0o755);
      quiet.mockRestore();
    }
  });
});
