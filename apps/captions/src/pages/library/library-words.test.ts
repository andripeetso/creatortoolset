import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIBRARY_WORDS } from "@contracts/library";
import { FOLDER_LABELS } from "@contracts/storage";

// G3 (UNIFIED-PRD §5.6): a label that more than one surface shows is written once, in LIBRARY_WORDS or FOLDER_LABELS,
// so the setup sheet, the owner's pages and the chat cannot drift apart. This reads those files and fails on a label of
// two words or more typed out again. Comments are skipped; it cannot judge a sentence, only a repeated label.
const here = path.dirname(fileURLToPath(import.meta.url));
const captions = path.resolve(here, "../..");

const walkWords = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(walkWords) : [];

const labels = [...walkWords(LIBRARY_WORDS), ...Object.values(FOLDER_LABELS)].filter((w) => w.trim().split(/\s+/).length >= 2);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a label as a string literal, JSX text or the start of one: `"Upload to server"`, `>Upload to server<`, a line of its own
const typedOut = (line: string, label: string) => new RegExp(`(["'\`>]|^\\s*)${escape(label)}(["'\`<:]|\\s*$)`).test(line);

const surfaces = [
  path.join(here, "Setup.tsx"),
  path.join(here, "LibrarySettings.tsx"),
  path.join(here, "Organize.tsx"),
  ...readdirSync(path.join(here, "settings"))
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => path.join(here, "settings", f)),
  path.join(captions, "components/FootageFolderCard.tsx"),
  path.join(captions, "components/assistant/ActionCard.tsx"),
];

const copies = (file: string) => {
  const found: string[] = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    for (const label of labels) if (typedOut(line, label)) found.push(`${path.relative(captions, file)}:${i + 1} "${label}"`);
  });
  return found;
};

describe("Media Library labels are written once (G3)", () => {
  it("the check catches a label typed out again", () => {
    expect(typedOut('<Row title="Upload to server" />', "Upload to server")).toBe(true);
    expect(typedOut("  Monthly budget", "Monthly budget")).toBe(true);
    expect(typedOut("{LIBRARY_WORDS.uploadToServer}", "Upload to server")).toBe(false);
  });

  for (const file of surfaces) {
    it(`${path.relative(captions, file)} repeats no LIBRARY_WORDS or FOLDER_LABELS literal`, () => {
      expect(copies(file)).toEqual([]);
    });
  }
});
