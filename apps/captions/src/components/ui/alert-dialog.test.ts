import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// A box pinned to all four sides of the window (inset-0) and sized by its content (h-fit) is as tall as its content
// in Chrome, but the Mac's own WebKit, which the Mac app's window uses, stretches it to the whole window: the confirm
// box did (a title at the top, its buttons in the middle, empty to the bottom). Centre such a box with top-1/2 left-1/2
// and [translate:-50%_-50%], as ui/dialog.tsx and ui/alert-dialog.tsx do. A test in a real browser cannot guard this:
// the test's own WebKit is a newer build that lays it out right.
it("no box is pinned to the window's sides and sized by its content", () => {
  const src = path.join(import.meta.dirname, "..", "..");
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));
  const sides = /\binset-(?:0|y-0)\b/;
  const byContent = /\bh-(?:fit|max|min)\b/;
  const found = files.flatMap((f) =>
    readFileSync(path.join(src, f), "utf8")
      .split("\n")
      .flatMap((line, i) => (sides.test(line) && byContent.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("{/*") ? [`${f}:${i + 1}`] : [])),
  );
  expect(found).toEqual([]);
});
