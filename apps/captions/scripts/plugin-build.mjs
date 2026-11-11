#!/usr/bin/env node
// Builds one plug-in folder by itself, for an app that is already built (the downloaded Mac app runs it; so can you):
//   node plugin-build.mjs check <folder>         prints what is wrong, or "ok"
//   node plugin-build.mjs build <folder> <out>   writes <out>/server.js, web.js, web.css and plugin.json
//   --app <dir>   the app's source (api/, src/, contracts/, tailwind.config.js); default: the folder above this file
//
// The plug-in's own files are bundled. What it imports from the app (../../api/lib/plugin, @/components/ui/button)
// and from the app's packages (hono, react) is not: the built file reads those from the running app
// (globalThis.__ctHost), so the plug-in uses the app's one copy of React, the router, the database and every module.
// The folder is read as if it were apps/captions/plugins/<id>, so the same files work in a checkout.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CODE, hostLists } from "./plugin-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ID_RE = /\bid:\s*"([^"]*)"/;
const VALID_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const read = (file) => readFileSync(file, "utf8");

/** What the plug-in says it is, read from the text (nothing in it runs): its id, name, one line, and which halves it has. */
export function readInfo(folder) {
  const files = { server: path.join(folder, "plugin.ts"), web: path.join(folder, "web.tsx") };
  const has = { server: existsSync(files.server), web: existsSync(files.web) };
  if (!has.server && !has.web) throw new Error("The folder has neither plugin.ts nor web.tsx");
  const texts = [has.server ? read(files.server) : "", has.web ? read(files.web) : ""];
  const ids = texts.map((t) => ID_RE.exec(t)?.[1]).filter((x) => x !== undefined);
  if (!ids.length) throw new Error('No id: write definePlugin({ id: "…" }) in plugin.ts and defineWebPlugin({ id: "…" }) in web.tsx');
  if (new Set(ids).size > 1) throw new Error(`plugin.ts and web.tsx have different ids ("${ids[0]}" and "${ids[1]}")`);
  const id = ids[0];
  if (!VALID_ID.test(id)) throw new Error(`The id "${id}" must be lowercase letters, digits and dashes`);
  // the plug-in's own name and line come right after its id (PLUGINS.md); a name further down belongs to a tile
  const near = (key) => texts.map((t) => new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(t.slice(ID_RE.exec(t)?.index ?? t.length).slice(0, 600))?.[1]).find(Boolean);
  return { id, name: near("name") ?? id, about: near("about") ?? "", server: has.server, web: has.web, files };
}

/** An import that leaves the plug-in's folder becomes a read from the running app; one the app doesn't have is an error. */
function hostLink(folder, id, list, needs, node) {
  const files = new Set(list.files);
  const packages = new Set(list.packages);
  const root = path.resolve(folder);
  return {
    name: "ct-host",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point" || a.namespace === "ct-host") return;
        const spec = a.path;
        if (spec.includes("?")) return { errors: [{ text: `"${spec}": imports with ?… work only when the app is built from a checkout` }] };
        let file;
        if (spec.startsWith("@/")) file = "src/" + spec.slice(2);
        else if (spec.startsWith("@contracts/")) file = "contracts/" + spec.slice(11);
        else if (spec.startsWith(".")) {
          const abs = path.resolve(a.resolveDir, spec);
          if (abs === root || abs.startsWith(root + path.sep)) return; // the plug-in's own file: bundled
          file = path.posix.normalize(`plugins/${id}/${path.relative(root, abs).split(path.sep).join("/")}`);
        } else if (node && (spec.startsWith("node:") || builtinModules.includes(spec))) return { external: true };
        let hostId;
        if (file !== undefined) {
          file = file.replace(CODE, "");
          hostId = [file, `${file}/index`].find((f) => files.has(f));
          if (!hostId) return { errors: [{ text: `"${spec}": the app has no ${file}${node ? "" : " for a page"}` }] };
        } else {
          if (!packages.has(spec)) return { errors: [{ text: `"${spec}": the app doesn't use this package${node ? " on the server" : " in its pages"}, so a plug-in can't import it` }] };
          hostId = "pkg:" + spec;
        }
        needs.add(hostId);
        return { path: hostId, namespace: "ct-host" };
      });
      // read from the running app when the plug-in loads; marked as an ES module, so default and named imports both work
      build.onLoad({ filter: /.*/, namespace: "ct-host" }, (a) => ({
        contents: `const m = globalThis.__ctHost.get(${JSON.stringify(a.path)}); module.exports = new Proxy(m, { get: (t, k) => (k === "__esModule" ? true : t[k]) });`,
        loader: "js",
      }));
    },
  };
}

/**
 * Every file that went into the bundle must be one of the folder's own. The link above sees the imports a file
 * writes, but not where the bundler goes by itself from inside the folder: a package.json there whose "main" or
 * "browser" points out of it, or a file that is a link to another place. The Mac app runs the copy a person switched
 * on and knows it by the fingerprint of that copy's files, so code bundled from anywhere else would run without ever
 * being part of what they switched on, and could change afterwards with the fingerprint the same.
 */
function ownFilesOnly(result, folder) {
  const root = realpathSync(folder);
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.startsWith("ct-host:")) continue; // read from the running app when the plug-in loads, not from a file
    let file = "";
    try {
      file = realpathSync(path.resolve(folder, input));
    } catch {
      // not a file that can be found again: refused below
    }
    if (!file.startsWith(root + path.sep)) throw new Error(`${path.relative(folder, path.resolve(folder, input))} is outside the plug-in's folder: a plug-in is built only from the files in its own folder`);
  }
}

/** esbuild's errors as plain lines, with paths inside the plug-in's folder. */
function problems(e, folder) {
  if (!Array.isArray(e?.errors)) return e instanceof Error ? e.message : String(e);
  return e.errors
    // esbuild names a file from the folder it was told to work in, not from where this program was started
    .map((x) => (x.location ? `${path.relative(folder, path.resolve(folder, x.location.file))}:${x.location.line}: ${x.text}` : x.text))
    .slice(0, 12)
    .join("\n");
}

/** Page paths the app itself has (<Route path="…"> in src/App.tsx): a plug-in page can't take one. */
const builtinPaths = (app) => new Set([...read(path.join(app, "src", "App.tsx")).matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]));

/**
 * Builds the plug-in in `folder` into `out`. Throws an Error whose message says what is wrong, in lines a person or
 * their AI can act on. Nothing of the plug-in runs here: its files are only read and bundled.
 */
export async function buildPlugin({ folder, out, app = path.resolve(HERE, "..") }) {
  folder = path.resolve(folder);
  const info = readInfo(folder);
  const lists = hostLists(app);
  if (info.web) {
    const taken = builtinPaths(app);
    for (const [, p] of read(info.files.web).matchAll(/\bpath:\s*"([^"]+)"/g)) if (taken.has(p)) throw new Error(`The page path ${p} is already a page of the app`);
  }
  const esbuild = require("esbuild");
  mkdirSync(out, { recursive: true });
  const needs = { server: new Set(), web: new Set() };
  const common = { bundle: true, format: "esm", logLevel: "silent", sourcemap: "inline", absWorkingDir: folder, metafile: true };
  const outputs = { server: path.join(out, "server.js"), web: path.join(out, "web.js") };
  let made = [];
  try {
    if (info.server)
      made.push(await esbuild.build({ ...common, entryPoints: [info.files.server], outfile: outputs.server, platform: "node", target: "node22", plugins: [hostLink(folder, info.id, lists.server, needs.server, true)] }));
    if (info.web)
      made.push(await esbuild.build({
        ...common,
        entryPoints: [info.files.web],
        outfile: path.join(out, "web.js"),
        platform: "browser",
        target: "es2022",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"' },
        loader: { ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl", ".webp": "dataurl", ".svg": "dataurl" },
        plugins: [hostLink(folder, info.id, lists.web, needs.web, false)],
      }));
  } catch (e) {
    throw new Error(problems(e, folder));
  }
  try {
    for (const result of made) ownFilesOnly(result, folder);
  } catch (e) {
    // what was bundled is not left behind for anything to load
    for (const file of [outputs.server, outputs.web, path.join(out, "web.css")]) rmSync(file, { force: true });
    throw e;
  }
  if (info.web) {
    // the plug-in's own classes with the app's theme: the app's stylesheet holds only the classes the app itself uses
    const config = require("tailwindcss/loadConfig")(path.join(app, "tailwind.config.js"));
    const css = await require("postcss")([require("tailwindcss")({ ...config, content: [path.join(folder, "**/*.{ts,tsx,js,jsx}")], corePlugins: { preflight: false } })]).process(
      "@tailwind components;\n@tailwind utilities;",
      { from: undefined },
    );
    const own = path.join(out, "web.css"); // esbuild wrote it when the plug-in imports its own .css
    writeFileSync(own, (existsSync(own) ? read(own) + "\n" : "") + css.css);
  }
  const built = { id: info.id, name: info.name, about: info.about, server: info.server, web: info.web, needs: { server: [...needs.server], web: [...needs.web] } };
  writeFileSync(path.join(out, "plugin.json"), JSON.stringify(built, null, 1) + "\n");
  return built;
}

// Command line.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--app");
  const app = at >= 0 ? path.resolve(args.splice(at, 2)[1]) : undefined;
  const [command, folder, out] = args;
  if (!["check", "build"].includes(command) || !folder || (command === "build" && !out)) {
    console.error("usage: plugin-build.mjs check <folder> | build <folder> <out> [--app <dir>]");
    process.exit(2);
  }
  const scratch = command === "check" ? mkdtempSync(path.join(os.tmpdir(), "ct-plugin-check-")) : null;
  try {
    if (!existsSync(folder) || !readdirSync(folder).length) throw new Error(`${folder} is empty or missing`);
    const built = await buildPlugin({ folder, out: scratch ?? out, app });
    console.log(command === "check" ? `ok: ${built.id} (${[built.server && "server", built.web && "page"].filter(Boolean).join(" + ")})` : JSON.stringify(built));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
