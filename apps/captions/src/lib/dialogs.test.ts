import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Asking, deleting and renaming happen in the app's own dialog (confirmDialog / promptDialog / alertDialog), never the
// browser's box, which the Mac app draws as a system alert. Reads the app's source (and a plug-in's, when one is copied in).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// plugins/ is there only when a plug-in is copied in (a fresh checkout has none)
const files = ["src", "plugins"].filter((d) => existsSync(path.join(root, d))).flatMap((d) =>
  (readdirSync(path.join(root, d), { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((f) => f.isFile() && /\.tsx?$/.test(f.name) && !f.name.includes(".test.") && !f.parentPath.includes("node_modules"))
    .map((f) => path.join(f.parentPath, f.name)),
);

describe("in-app dialogs", () => {
  it("no window.confirm / prompt / alert outside lib/dialogs.ts", () => {
    const odd = files
      .filter((f) => !f.endsWith(path.join("lib", "dialogs.ts")))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .flatMap((line, i) => (/window\.(confirm|prompt|alert)\(/.test(line) ? [`${path.relative(root, f)}:${i + 1}`] : [])),
      );
    expect(odd).toEqual([]);
  });
});
