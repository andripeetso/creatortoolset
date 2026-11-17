import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// The server bundle's banner (package.json build) declares createRequire itself, so a named import of it anywhere in
// api/ makes dist/boot.js fail to start ("Identifier 'createRequire' has already been declared"). Tests never build the
// bundle, so this is the only test that sees it (11-16: a deploy of creatortoolset.com rolled back on it).
it("no server file imports createRequire by name from node:module", () => {
  const root = import.meta.dirname;
  const named = /import\s*\{[^}]*\bcreateRequire\b[^}]*\}\s*from\s*["']node:module["']/;
  const bad = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !f.includes("node_modules"))
    .filter((f) => named.test(readFileSync(path.join(root, f), "utf8")));
  expect(bad).toEqual([]);
});
