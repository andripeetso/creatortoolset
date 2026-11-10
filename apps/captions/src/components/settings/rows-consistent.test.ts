import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every Settings screen draws its rows the same way (the kit, ui.tsx). These read the screens' source, so a new screen
// that goes its own way fails here instead of being noticed on a screenshot.
const dir = path.dirname(fileURLToPath(import.meta.url));
const screens = readdirSync(dir)
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
  .map((f) => ({ file: f, lines: readFileSync(path.join(dir, f), "utf8").split("\n") }));

describe("Settings rows are the same on every screen", () => {
  it("row buttons are one size (sm): xs is only a ghost button, the + Add beside a section's title and Usage's period picker", () => {
    const odd: string[] = [];
    for (const { file, lines } of screens)
      lines.forEach((line, i) => {
        if (!line.includes('size="xs"') || line.trimStart().startsWith("*")) return;
        // the button's own tag: this line and the few around it (a tag with one prop per line)
        if (!lines.slice(Math.max(0, i - 3), i + 4).join("\n").includes('"ghost"')) odd.push(`${file}:${i + 1}`);
      });
    expect(odd).toEqual([]);
  });

  it("the one in use or connected is the kit's InUse (green dot, green word), never a green state made by hand", () => {
    const odd = screens
      .filter(({ file }) => file !== "kit-controls.tsx")
      .flatMap(({ file, lines }) => lines.flatMap((line, i) => (/tone="ok"|text-emerald-\d/.test(line) ? [`${file}:${i + 1}`] : [])));
    expect(odd).toEqual([]);
  });
});
