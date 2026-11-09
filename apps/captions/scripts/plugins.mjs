#!/usr/bin/env node
// Finds the plug-ins and writes the two registries the app imports: api/plugins.gen.ts (server) and
// src/plugins.gen.ts (web). Runs before dev, build, check and test (package.json).
//
// A plug-in is a folder with plugin.ts (server entry, definePlugin) and/or web.tsx (browser entry,
// defineWebPlugin). Without CT_PLUGINS every folder under plugins/ is used. CT_PLUGINS=a,b uses only the
// named folders, looked up in plugins/ and then in plugin-examples/. Exits non-zero on a duplicate plug-in
// id, on a web route that repeats a built-in page path or another plug-in's path, and on a folder with
// neither file. A plug-in's env names that are unset are only reported, never fatal.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "dotenv";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ID_RE = /\bid:\s*"([a-z0-9][a-z0-9-]*)"/;
const ENV_RE = /\benv:\s*\[([^\]]*)\]/;
const WEB_PATH_RE = /\bpath:\s*"([^"]+)"/g;
const BUILTIN_PATH_RE = /<Route\s+path="([^"]+)"/g;

const read = (file) => readFileSync(file, "utf8");
const importPath = (from, to) => {
  const rel = path.relative(path.dirname(from), to).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
};

/** The folders to load, as { dir, name } (name is the folder name), in a stable order. */
function findFolders(root, names) {
  const found = [];
  if (names === null) {
    const dir = path.join(root, "plugins");
    if (!existsSync(dir)) return found;
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (d.isDirectory()) found.push({ dir: path.join(dir, d.name), name: d.name });
    }
    return found;
  }
  for (const name of names) {
    const hit = ["plugins", "plugin-examples"].map((base) => path.join(root, base, name)).find((d) => existsSync(d));
    if (!hit) throw new Error(`CT_PLUGINS names "${name}", but there is no plugins/${name} or plugin-examples/${name}`);
    found.push({ dir: hit, name });
  }
  return found;
}

/** Paths of the built-in pages, from the <Route path="…"> lines of src/App.tsx. */
function builtinPaths(sourceRoot) {
  const app = path.join(sourceRoot, "src", "App.tsx");
  return new Set([...read(app).matchAll(BUILTIN_PATH_RE)].map((m) => m[1]));
}

/**
 * Builds both registries for the plug-ins in `root` (the app folder) and writes them.
 * `sourceRoot` is where src/App.tsx is read from for the built-in paths (defaults to `root`).
 * Returns the warnings it found (unset env names) and the plug-in ids, and throws on any fatal problem.
 */
export function generate({ root = APP_ROOT, sourceRoot = root, names = null, env = {} } = {}) {
  const plugins = [];
  const ids = new Set();
  const webPaths = new Map();
  const builtins = builtinPaths(sourceRoot);
  const warnings = [];

  for (const { dir, name } of findFolders(root, names)) {
    const serverFile = path.join(dir, "plugin.ts");
    const webFile = path.join(dir, "web.tsx");
    const hasServer = existsSync(serverFile);
    const hasWeb = existsSync(webFile);
    if (!hasServer && !hasWeb) throw new Error(`plug-in folder ${name} has neither plugin.ts nor web.tsx`);

    const declared = [
      hasServer ? ID_RE.exec(read(serverFile))?.[1] : undefined,
      hasWeb ? ID_RE.exec(read(webFile))?.[1] : undefined,
    ];
    const id = declared.find(Boolean);
    if (!id) throw new Error(`plug-in ${name} declares no id (definePlugin / defineWebPlugin with id: "…")`);
    if (declared.some((d) => d && d !== id)) throw new Error(`plug-in ${name}: plugin.ts and web.tsx declare different ids`);
    if (ids.has(id)) throw new Error(`duplicate plug-in id "${id}" (second copy in ${name})`);
    ids.add(id);

    if (hasWeb) {
      for (const [, p] of read(webFile).matchAll(WEB_PATH_RE)) {
        if (builtins.has(p)) throw new Error(`plug-in ${id}: web route ${p} is already a built-in page`);
        if (webPaths.has(p)) throw new Error(`plug-in ${id}: web route ${p} is also in plug-in ${webPaths.get(p)}`);
        webPaths.set(p, id);
      }
    }

    const envNames = hasServer ? [...(ENV_RE.exec(read(serverFile))?.[1] ?? "").matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]) : [];
    for (const v of envNames) {
      if (env[v] === undefined) warnings.push(`plug-in ${id} reads ${v}, which is not set`);
    }

    plugins.push({ id, serverFile: hasServer ? serverFile : null, webFile: hasWeb ? webFile : null });
  }

  const serverFiles = plugins.filter((p) => p.serverFile);
  const webFiles = plugins.filter((p) => p.webFile);

  const serverOut = path.join(root, "api", "plugins.gen.ts");
  const webOut = path.join(root, "src", "plugins.gen.ts");
  mkdirSync(path.dirname(serverOut), { recursive: true });
  mkdirSync(path.dirname(webOut), { recursive: true });
  writeFileSync(
    serverOut,
    [
      "// Generated by scripts/plugins.mjs. Do not edit.",
      'import type { ServerPlugin } from "./lib/plugin";',
      ...serverFiles.map((p, i) => `import plugin${i} from "${importPath(serverOut, p.serverFile.replace(/\.ts$/, ""))}";`),
      `export const serverPlugins: ServerPlugin[] = [${serverFiles.map((_, i) => `plugin${i}`).join(", ")}];`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    webOut,
    [
      "// Generated by scripts/plugins.mjs. Do not edit.",
      'import type { WebPlugin } from "./lib/plugin";',
      ...webFiles.map((p, i) => `import web${i} from "${importPath(webOut, p.webFile.replace(/\.tsx$/, ""))}";`),
      `export const webPlugins: WebPlugin[] = [${webFiles.map((_, i) => `web${i}`).join(", ")}];`,
      "",
    ].join("\n"),
  );

  return { ids: [...ids], warnings };
}

// Command line: read .env for the unset-env report, pick plug-ins from CT_PLUGINS, print the result.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const envFile = path.join(APP_ROOT, ".env");
  const env = { ...(existsSync(envFile) ? parse(read(envFile)) : {}), ...process.env };
  const names = process.env.CT_PLUGINS === undefined ? null : process.env.CT_PLUGINS.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const { ids, warnings } = generate({ root: APP_ROOT, names, env });
    for (const w of warnings) console.warn(`[plugins] ${w}`);
    console.log(`[plugins] ${ids.length ? ids.join(", ") : "no plug-ins"}`);
  } catch (err) {
    console.error(`[plugins] ${err.message}`);
    process.exit(1);
  }
}
