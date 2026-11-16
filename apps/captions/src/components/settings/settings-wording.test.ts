import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Settings wording is one standard (AGENTS.md, "Settings wording"). This reads the screens' source for the forms that
// kept coming back, so a new one fails here instead of being noticed on a screenshot. It cannot judge a sentence; it
// only catches the mechanical ones.
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(dir, "../..");
/** Settings screens that live outside this folder. */
const ELSEWHERE = [
  "pages/library/LibrarySettings.tsx",
  "pages/library/UploadSelect.tsx",
  "pages/LibraryStorage.tsx",
  "pages/LibraryWatchFolders.tsx",
  "components/setup/HelperStep.tsx",
];
const files = [
  ...readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.") && f !== "search.ts")
    .map((f) => `components/settings/${f}`),
  ...ELSEWHERE,
];

const BANNED: Array<[RegExp, string]> = [
  [/\b(your|my)( own| connected)? AIs?\b/i, 'say "AI provider", never "your AI"'],
  [/\bby itself\b/i, "things do not act like people"],
  [/\bshows? up\b/i, "things do not act like people"],
  [/\bno longer here\b|\b(is|are|that is) gone\b/i, 'say the state: "Not found"'],
  [/"[^"]*\b(I|my|me) [^"]*"/, "nobody is speaking: no I, me, my"],
  [/\btitle="[^"]*[?.]"|\btitle=\{`[^`]*[?.]`\}/, "a title is a noun: no question, no full stop"],
];

/** Screens not yet rewritten to the standard: the list only shrinks, and a new screen never goes on it. */
const NOT_YET = new Set([
  "components/settings/AccessKeys.tsx",
  "components/settings/ComputersSection.tsx",
  "components/settings/OwnAiSection.tsx",
  "components/settings/ProvidersSection.tsx",
  "components/settings/UsageSection.tsx",
  "pages/library/LibrarySettings.tsx",
  "components/setup/HelperStep.tsx",
]);

const offences = (file: string): string[] =>
  readFileSync(path.join(src, file), "utf8")
    .split("\n")
    .flatMap((line, i) => {
      const t = line.trim();
      if (/^(\*|\/\/|\/\*|\{\/\*)/.test(t)) return [];
      const code = line.replace(/\s\/\/.*$/, "");
      return BANNED.filter(([re]) => re.test(code)).map(([, why]) => `${file}:${i + 1} ${why}`);
    });

describe("Settings wording", () => {
  it("no screen uses a banned form", () => {
    expect(files.filter((f) => !NOT_YET.has(f)).flatMap(offences)).toEqual([]);
  });
});
