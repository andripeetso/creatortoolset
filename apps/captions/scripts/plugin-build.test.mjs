import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPlugin } from "./plugin-build.mjs";
import { hostLists, packagesIn } from "./plugin-host.mjs";

// The example plug-in is compiled into a checkout's build by scripts/plugins.mjs (plugins.test.mjs, api/mcp.test.ts).
// Here the same folder is built by itself, the way the Mac app builds a folder from the person's plug-ins folder, and
// loaded against the app's real modules: the two ways a plug-in gets into the app must take the same files.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(APP, "node_modules", ".tmp", `plugin-build-${process.pid}`);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The running app, for a built file: the modules it asks for, loaded from this checkout. */
async function host(needs, load) {
  const table = new Map();
  for (const id of needs) table.set(id, await load(id));
  globalThis.__ctHost = { get: (id) => table.get(id) };
}
const folder = (name, files) => {
  const dir = path.join(tmp, "src", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
};
const build = (dir) => buildPlugin({ folder: dir, out: path.join(tmp, "out", path.basename(dir)) });

describe("the example plug-in, built by itself", () => {
  it("builds, and asks the app only for modules the Mac build lists", async () => {
    const built = await buildPlugin({ folder: path.join(APP, "plugin-examples", "hello"), out: path.join(tmp, "hello") });
    expect(built).toMatchObject({ id: "hello", name: "Hello", server: true, web: true });
    const lists = hostLists(APP);
    const has = (side) => new Set([...lists[side].files, ...lists[side].packages.map((p) => "pkg:" + p)]);
    for (const need of built.needs.server) expect(has("server")).toContain(need);
    for (const need of built.needs.web) expect(has("web")).toContain(need);
    for (const f of ["server.js", "web.js", "web.css", "plugin.json"]) expect(existsSync(path.join(tmp, "hello", f))).toBe(true);
  });

  it("its server half loads against the app's own modules and its route is behind its gate", async () => {
    const { needs } = JSON.parse(readFileSync(path.join(tmp, "hello", "plugin.json"), "utf8"));
    await host(needs.server, (id) => (id === "pkg:hono" ? import("hono") : import(/* @vite-ignore */ path.join(APP, id))));
    const plugin = (await import(/* @vite-ignore */ pathToFileURL(path.join(tmp, "hello", "server.js")).href)).default;
    expect(plugin.id).toBe("hello");
    expect(plugin.gates.ids).toEqual(["hello"]);
    // requireGate is the app's own: with no signed-in account the route refuses
    expect((await plugin.routes.request("/ping")).status).toBe(403);
    expect(plugin.tools.defs.map((d) => d.name)).toContain("hello_greet");
  });

  it("its page half loads against the app's own modules", async () => {
    const { needs } = JSON.parse(readFileSync(path.join(tmp, "hello", "plugin.json"), "utf8"));
    await host(needs.web, (id) => (id.startsWith("pkg:") ? import(/* @vite-ignore */ id.slice(4)) : import(/* @vite-ignore */ path.join(APP, id))));
    const plugin = (await import(/* @vite-ignore */ pathToFileURL(path.join(tmp, "hello", "web.js")).href)).default;
    expect(plugin.id).toBe("hello");
    expect(plugin.routes.map((r) => r.path)).toEqual(["/hello"]);
    expect(plugin.tiles[0].name).toBe("Hello");
  });
});

describe("what the builder refuses, in words a person or their AI can act on", () => {
  const head = 'import { definePlugin } from "../../api/lib/plugin";\n';
  const cases = [
    ["a folder with neither file", { "notes.txt": "x" }, /neither plugin\.ts nor web\.tsx/],
    ["no id", { "plugin.ts": head + "export default definePlugin({});\n" }, /No id/],
    ["two ids", { "plugin.ts": head + 'export default definePlugin({ id: "a" });\n', "web.tsx": 'export default { id: "b" };\n' }, /different ids/],
    ["an id with capitals", { "plugin.ts": head + 'export default definePlugin({ id: "Sponsors" });\n' }, /lowercase letters, digits and dashes/],
    ["a package the app doesn't use", { "plugin.ts": head + 'import pad from "left-pad";\nexport default definePlugin({ id: "a", about: pad });\n' }, /"left-pad": the app doesn't use this package on the server/],
    ["a file the app doesn't have", { "plugin.ts": head + 'import { x } from "../../api/lib/nope";\nexport default definePlugin({ id: "a", about: x });\n' }, /the app has no api\/lib\/nope/],
    ["a file outside the app", { "plugin.ts": head + 'import { x } from "../../../secrets";\nexport default definePlugin({ id: "a", about: x });\n' }, /the app has no/],
    ["a ?url import", { "web.tsx": 'import u from "./a.png?url";\nexport default { id: "a", about: u };\n' }, /imports with \?… work only when the app is built from a checkout/],
    ["a page path the app has", { "web.tsx": 'export default { id: "a", routes: [{ path: "/library", element: null }] };\n' }, /\/library is already a page of the app/],
    ["a syntax error", { "plugin.ts": head + "export default definePlugin({ id: \"a\", );\n" }, /plugin\.ts:2: /],
  ];
  it.each(cases)("refuses %s", async (what, files, why) => {
    await expect(build(folder(what.replace(/\W+/g, "-"), files))).rejects.toThrow(why);
  });

  it("bundles the plug-in's own files and its own stylesheet", async () => {
    const dir = folder("own-files", {
      "plugin.ts": head + 'import { greeting } from "./lib/words";\nexport default definePlugin({ id: "own", about: greeting });\n',
      "lib/words.ts": 'export const greeting = "hello from a second file";\n',
    });
    writeFileSync(path.join(dir, "web.tsx"), 'import "./own.css";\nexport default { id: "own", routes: [{ path: "/own", element: <p className="p-[37px]">x</p> }] };\n');
    writeFileSync(path.join(dir, "own.css"), ".own-rule { color: rebeccapurple }\n");
    const built = await build(dir);
    expect(built.needs.server).toEqual(["api/lib/plugin"]);
    expect(readFileSync(path.join(tmp, "out", "own-files", "server.js"), "utf8")).toContain("hello from a second file");
    const css = readFileSync(path.join(tmp, "out", "own-files", "web.css"), "utf8");
    expect(css).toContain("rebeccapurple");
    expect(css).toContain("37px");
  });
});

describe("what a plug-in may ask the app for", () => {
  const lists = hostLists(APP);
  it("lists the app's own files, without tests, entries, generated lists or workers", () => {
    expect(lists.server.files).toEqual(expect.arrayContaining(["api/lib/plugin", "api/lib/env", "contracts/tools"]));
    expect(lists.web.files).toEqual(expect.arrayContaining(["src/lib/plugin", "src/components/ui/button", "contracts/tools"]));
    for (const id of [...lists.server.files, ...lists.web.files]) expect(id).not.toMatch(/\.test$|\.gen$|^src\/workers\//);
    for (const id of ["api/boot", "api/connect/cli-bin"]) expect(lists.server.files).not.toContain(id);
    for (const id of ["src/main", "src/render-entry"]) expect(lists.web.files).not.toContain(id);
  });
  it("lists a package only when a file imports its code and package.json has it", () => {
    const installed = new Set(["hono", "react", "zod"]);
    const text = 'import { Hono } from "hono";\nimport type { ZodType } from "zod";\nimport x from "./local";\nimport fs from "node:fs";\n// from "left-pad"\nconst r = await import("react");\nimport { T } from "@contracts/tools";\n';
    expect([...packagesIn(text, installed)].sort()).toEqual(["hono", "react"]);
    expect(lists.server.packages).toContain("hono");
    expect(lists.web.packages).toEqual(expect.arrayContaining(["react", "react/jsx-runtime", "react-router", "lucide-react"]));
  });
});
