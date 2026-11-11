// Which of the app's own files and packages a plug-in built by itself (scripts/plugin-build.mjs) can ask the running
// app for. scripts/plugins.mjs writes them into the two host lists (api/plugin-host.gen.ts, src/plugin-host.gen.ts);
// the builder reads the same answer, so a plug-in that imports something the app doesn't have fails with its name.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

export const CODE = /\.(ts|tsx)$/;
const SKIP = /\.(test|spec|gen)\.|\.d\.ts$/;
// vite.config.ts and vitest.config.ts name these: the app's own folders, never packages
const ALIASES = new Set(["@contracts", "@db", "@assets", "db", "ort-dist"]);
const PACKAGE = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(\/[A-Za-z0-9._/-]+)?$/;

const read = (file) => readFileSync(file, "utf8");
const walk = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : CODE.test(d.name) && !SKIP.test(d.name) ? [path.join(dir, d.name)] : []));

/** The packages a file imports for their code. A type-only import brings none, and neither does an app folder alias. */
export function packagesIn(text, installed) {
  const out = new Set();
  const code = text.replace(/import\s+type\s[^;]*?from\s*["'][^"']+["']/gs, "");
  for (const [, spec] of code.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s+)["']([^"'\n]+)["']/g)) {
    const m = PACKAGE.exec(spec);
    if (!m || spec.startsWith("node:") || builtinModules.includes(m[1]) || ALIASES.has(m[1])) continue;
    // a name in a comment or a string is only a package when package.json has it
    if (installed.has(m[1])) out.add(spec);
  }
  return out;
}

/** The files a page loads by itself (<script src="/src/…"> in the app's .html files): entries, never asked for by a plug-in. */
function htmlEntries(root) {
  const out = new Set();
  for (const f of readdirSync(root).filter((n) => n.endsWith(".html"))) {
    for (const [, src] of read(path.join(root, f)).matchAll(/<script[^>]+src="\/([^"]+)"/g)) out.add(src.replace(CODE, ""));
  }
  return out;
}

function side(root, dirs, skip, installed, always = []) {
  const files = [];
  const packages = new Set(always);
  for (const file of dirs.flatMap((d) => walk(path.join(root, d)))) {
    const id = path.relative(root, file).split(path.sep).join("/").replace(CODE, "");
    const text = read(file);
    // a command-line entry, a test helper or a web worker (its own bundle) is never a module of the running app
    if (skip.has(id) || id.startsWith("src/workers/") || text.startsWith("#!") || /from\s+["']vitest["']/.test(text)) continue;
    files.push(id);
    for (const p of packagesIn(text, installed)) packages.add(p);
  }
  return { files, packages: [...packages].sort() };
}

/**
 * The ids a plug-in may ask for, per side: an app file by its path without the ending ("api/lib/plugin",
 * "src/components/ui/button", "contracts/tools"), and a package entry the app itself imports ("hono", "react").
 */
export function hostLists(root) {
  const pkg = JSON.parse(read(path.join(root, "package.json")));
  const installed = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  return {
    server: side(root, ["api", "contracts", "db"], new Set(["api/boot", "api/connect/cli-bin"]), installed),
    web: side(root, ["src", "contracts"], htmlEntries(root), installed, ["react/jsx-runtime"]),
  };
}
