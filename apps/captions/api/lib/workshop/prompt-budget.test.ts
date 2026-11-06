import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSystemFor } from "./chat-prompt";
import type { DocKind } from "./types";

// The static system text every Workshop turn pays for (and every Mac Claude
// session that reads the folder). Measured in UTF-8 bytes, committed in
// prompt-budget.json. Growth must be deliberate: rerun the Workshop eval
// (scripts/workshop-eval.ts), then write the new sizes with
// UPDATE_PROMPT_BUDGET=1 npx vitest run api/lib/workshop/prompt-budget.test.ts.
// Never fix a failing grade by adding prompt text.
const KINDS: DocKind[] = ["reel", "carousel", "ad", "free", "notes"];
const FILE = new URL("./prompt-budget.json", import.meta.url);
const committed = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, number>;

const measured = (): Record<string, number> =>
  Object.fromEntries(
    KINDS.flatMap((kind) => [
      [`${kind}:fetch`, Buffer.byteLength(chatSystemFor(kind, false), "utf8")],
      [`${kind}:folder`, Buffer.byteLength(chatSystemFor(kind, true), "utf8")],
    ]),
  );

describe("Workshop system text budget", () => {
  it("is the committed size, per kind, with and without the folder", () => {
    if (process.env.UPDATE_PROMPT_BUDGET) {
      writeFileSync(FILE, JSON.stringify(measured(), null, 2) + "\n");
      return;
    }
    expect(measured(), "Workshop system text changed size: growth must be deliberate. Rerun scripts/workshop-eval.ts, then UPDATE_PROMPT_BUDGET=1 to write the new sizes. Never fix a failing grade by adding prompt text.").toEqual(committed);
  });
});
