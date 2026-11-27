import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every menu has one look: ContextMenu, DropdownMenu, or PointMenu for one opened at a click. A menu of plain buttons
// drifts from it (its own border, size, hover, submenus), which is how five menus ended up looking five ways.
const src = join(__dirname, "../..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.tsx$/.test(d.name) && !/\.test\./.test(d.name) ? [join(dir, d.name)] : [],
  );

describe("menus", () => {
  it("no screen builds a menu of its own", () => {
    const own = files(src)
      .filter((f) => !f.includes(`${join("components", "ui")}`))
      .filter((f) => /<[a-z]+ [^>]*role="menu"/.test(readFileSync(f, "utf8"))) // markup, not a [role="menu"] selector
      .map((f) => relative(src, f));
    expect(own).toEqual([]);
  });
});
