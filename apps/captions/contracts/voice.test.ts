import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { STT_MODELS } from "./voice";

// The Linux helper (public/helper/helper.py) keeps its own map of what to download: it must be the catalog's.
it("the helper downloads exactly the catalog's computer models, from their `download` repositories", () => {
  const py = readFileSync(path.join(import.meta.dirname, "../public/helper/helper.py"), "utf-8");
  const block = /CATALOG = \{([\s\S]*?)\n\}/.exec(py)![1]!;
  const helper = Object.fromEntries([...block.matchAll(/"([^"]+)": \("([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const catalog = Object.fromEntries(STT_MODELS.filter((m) => m.computer).map((m) => [m.id, m.download]));
  expect(helper).toEqual(catalog);
});
