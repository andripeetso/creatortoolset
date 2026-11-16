import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The app's wording is one standard (AGENTS.md, "App wording"). This reads every screen's source for the forms that kept
// coming back, so a new one fails here instead of being noticed on a screenshot. It cannot judge a sentence; it only
// catches the mechanical ones. Settings has its own, stricter list (components/settings/settings-wording.test.ts).
const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [here, path.resolve(here, "../editor-steps")];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const at = path.join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(at).isDirectory()) return walk(at);
    // a step's engine.ts holds another program's source as text, not screen wording
    return /\.tsx?$/.test(name) && !name.includes(".test.") && !name.endsWith(".d.ts") && name !== "engine.ts" ? [at] : [];
  });

const BANNED: Array<[RegExp, string]> = [
  [/\b(your|my)( own| connected)? AIs?\b/i, 'never "your AI": say "AI provider", or name what it does'],
  [/\b(Sparkles|Wand2|WandSparkles|Stars)\b/, "no wand or sparkle icon: CtMark, or the icon of what the button does"],
  [/>\s*Try again\s*<|"Try again"/, 'the button is "Retry"'],
  [/Couldn(’|')t /, '"Could not <verb> <thing>"'],
  [/\bby itself\b|\bshows? up\b|\bno longer here\b|\b(is|are) gone\b/i, "things do not act like people: say the state"],
];

/** The owner's own wording, kept as it is (AGENTS.md, "App wording"): the line must hold one of these to pass. */
const KEPT = ["Connect your AI", "WELCOME_", '"use from your ai"'];

describe("App wording", () => {
  it("no screen uses a banned form", () => {
    const found = roots.flatMap(walk).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => {
          const t = line.trim();
          if (/^(\*|\/\/|\/\*|\{\/\*)/.test(t) || KEPT.some((k) => line.includes(k))) return [];
          const code = line.replace(/\s\/\/.*$/, "");
          return BANNED.filter(([re]) => re.test(code)).map(([, why]) => `${path.relative(here, file)}:${i + 1} ${why}`);
        }),
    );
    expect(found).toEqual([]);
  });
});
