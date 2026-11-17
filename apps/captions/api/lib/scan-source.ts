/** For the ratchet tests (prevention.test.ts, library/upload-gate.test.ts): which source files say a thing. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The repository root. */
export const repo = path.resolve(import.meta.dirname, "../../../..");

/** Non-test files under `rel` (from the repository root) named like `ext` whose text matches `re`, sorted, relative to the root. */
export function filesMatching(rel: string, re: RegExp, ext: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const f = path.join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (ext.test(n) && !/\.test\.|Tests?\//.test(path.relative(repo, f)) && re.test(readFileSync(f, "utf8"))) out.push(path.relative(repo, f));
    }
  };
  walk(path.join(repo, rel));
  return out.sort();
}
