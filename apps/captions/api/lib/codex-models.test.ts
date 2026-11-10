import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_MODELS, type ProviderInstance } from "../../contracts/providers";
import { codexLoginModels, modelsFor } from "./providers";

const codex: ProviderInstance = { id: "codex", driver: "codex", name: "Codex", enabled: true };
let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  process.env.CT_LOCAL = "1";
  process.env.CODEX_HOME = home;
});
afterEach(() => {
  delete process.env.CT_LOCAL;
  delete process.env.CODEX_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("Codex's model list follows the login on this Mac", () => {
  it("offers the listed slugs by priority, skipping hidden ones, and never the fallback", () => {
    writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [
      { slug: "gpt-hidden", visibility: "hide", priority: 1 },
      { slug: "gpt-new", visibility: "list", priority: 2 },
      { slug: "gpt-older", visibility: "list", priority: 3 },
    ] }));
    expect(codexLoginModels()).toEqual(["gpt-new", "gpt-older"]);
    expect(modelsFor(codex)).toEqual(["gpt-new", "gpt-older"]);
  });

  it("falls back to the driver's list when the cache is missing, and off the Mac's server it never reads the cache", () => {
    expect(modelsFor(codex)).toEqual(DRIVER_MODELS.codex);
    writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-new", visibility: "list", priority: 1 }] }));
    delete process.env.CT_LOCAL;
    expect(modelsFor(codex)).toEqual(DRIVER_MODELS.codex);
  });
});
