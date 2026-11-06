import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The open app never imports the paid hosted code in cloud/ (cloud/README.md):
 * a self-hosted copy has no cloud/ folder and must still build and run.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const CLOUD_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'][^"']*\bcloud\//;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

describe("cloud/ boundary", () => {
  it("nothing outside cloud/ imports from it", () => {
    const offenders = ["api", "src", "contracts"]
      .flatMap((d) => sources(path.join(ROOT, d)))
      .filter((f) => f !== import.meta.filename && CLOUD_IMPORT.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the check catches an import", () => {
    expect(CLOUD_IMPORT.test(`import { limitsFor } from "../cloud/plans";`)).toBe(true);
    expect(CLOUD_IMPORT.test(`const m = await import("../../cloud/billing");`)).toBe(true);
    expect(CLOUD_IMPORT.test(`const cloud = user.cloud; // cloud transcription`)).toBe(false);
  });
});
