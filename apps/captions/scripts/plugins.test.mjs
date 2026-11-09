import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./plugins.mjs";

// Each test builds a throwaway app folder under node_modules/.tmp (already git-ignored, on the SSD with the rest of the build).
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let root;

beforeEach(() => {
  root = path.join(APP, "node_modules", ".tmp", `plugins-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const plugin = (dir, id, extra = "") => {
  mkdirSync(path.join(root, "plugins", dir), { recursive: true });
  writeFileSync(path.join(root, "plugins", dir, "plugin.ts"), `export default definePlugin({ id: "${id}", ${extra} });\n`);
};
const webPlugin = (dir, id, routePath) => {
  mkdirSync(path.join(root, "plugins", dir), { recursive: true });
  writeFileSync(
    path.join(root, "plugins", dir, "web.tsx"),
    `export default defineWebPlugin({ id: "${id}", routes: [{ path: "${routePath}", element: null }] });\n`,
  );
};

describe("plug-in generator", () => {
  it("writes empty registries when there is no plugins folder", () => {
    const { ids, warnings } = generate({ root, sourceRoot: APP });
    expect(ids).toEqual([]);
    expect(warnings).toEqual([]);
    expect(readFileSync(path.join(root, "api/plugins.gen.ts"), "utf8")).toContain("serverPlugins: ServerPlugin[] = [];");
    expect(readFileSync(path.join(root, "src/plugins.gen.ts"), "utf8")).toContain("webPlugins: WebPlugin[] = [];");
  });

  it("loads the named example from plugin-examples and imports both halves", () => {
    cpSync(path.join(APP, "plugin-examples/hello"), path.join(root, "plugin-examples/hello"), { recursive: true });
    const { ids, warnings } = generate({ root, sourceRoot: APP, names: ["hello"], env: {} });
    expect(ids).toEqual(["hello"]);
    expect(readFileSync(path.join(root, "api/plugins.gen.ts"), "utf8")).toContain(
      'import plugin0 from "../plugin-examples/hello/plugin";',
    );
    expect(readFileSync(path.join(root, "src/plugins.gen.ts"), "utf8")).toContain(
      'import web0 from "../plugin-examples/hello/web";',
    );
    expect(warnings).toEqual(["plug-in hello reads HELLO_GREETING, which is not set"]);
  });

  it("reports an env name as set when it has a value", () => {
    cpSync(path.join(APP, "plugin-examples/hello"), path.join(root, "plugin-examples/hello"), { recursive: true });
    const { warnings } = generate({ root, sourceRoot: APP, names: ["hello"], env: { HELLO_GREETING: "hi" } });
    expect(warnings).toEqual([]);
  });

  it("fails on a duplicate plug-in id", () => {
    plugin("a", "dup");
    plugin("b", "dup");
    expect(() => generate({ root, sourceRoot: APP })).toThrow('duplicate plug-in id "dup"');
  });

  it("fails when a web route repeats a built-in page path", () => {
    webPlugin("c", "clash", "/library");
    expect(() => generate({ root, sourceRoot: APP })).toThrow("web route /library is already a built-in page");
  });

  it("fails when two plug-ins claim the same web route", () => {
    webPlugin("d", "one", "/shared");
    webPlugin("e", "two", "/shared");
    expect(() => generate({ root, sourceRoot: APP })).toThrow("web route /shared is also in plug-in");
  });

  it("fails on a folder with neither plugin.ts nor web.tsx", () => {
    mkdirSync(path.join(root, "plugins/empty"), { recursive: true });
    expect(() => generate({ root, sourceRoot: APP })).toThrow("neither plugin.ts nor web.tsx");
  });

  it("fails when CT_PLUGINS names a plug-in that does not exist", () => {
    expect(() => generate({ root, sourceRoot: APP, names: ["missing"] })).toThrow('names "missing"');
  });
});
