import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "workspace-context-"));
process.env.DATA_DIR = dir;
const { renderContext, workspaceContext, workspaceSources } = await import("./context");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const put = (kind: "projects" | "sources", id: string, rec: object, text?: string) => {
  mkdirSync(path.join(dir, "workshop", kind), { recursive: true });
  writeFileSync(path.join(dir, "workshop", kind, `${id}.json`), JSON.stringify({ id, createdAt: 1, updatedAt: 1, ...rec }));
  if (text !== undefined) writeFileSync(path.join(dir, "workshop", kind, `${id}.txt`), text);
};
const project = { owner: "ana", name: "Ember Realm", audience: "RPG veterans", voice: "", cta: "", notes: "A free online fantasy RPG server." };

describe("a workspace's context, carried to every AI in it", () => {
  it("reads its own files and the account's general ones; never another workspace's, another account's or one it switched off", async () => {
    put("projects", "p-ember", { ...project, off: ["s_off"] });
    put("sources", "s_own", { owner: "ana", name: "lands.md", projectId: "p-ember", status: "read", title: "The lands", kind: "brand", about: "Every land: Frost Peak is the snowy one." }, "# Lands");
    put("sources", "s_all", { owner: "ana", name: "voice.md", status: "new" }, "Short lines.");
    put("sources", "s_other", { owner: "ana", name: "elsewhere.md", projectId: "p-other" }, "x");
    put("sources", "s_off", { owner: "ana", name: "old.md" }, "x");
    put("sources", "s_bob", { owner: "bob", name: "bob.md" }, "x");
    const ids = (await workspaceSources({ ...project, id: "p-ember", off: ["s_off"], createdAt: 1, updatedAt: 1 })).map((s) => s.id).sort();
    expect(ids).toEqual(["s_all", "s_own"]);

    const ctx = await workspaceContext("p-ember", 6000);
    expect(ctx).toMatch(/^Workspace: Ember Realm[\s\S]*A free online fantasy RPG server/);
    expect(ctx).toMatch(/Context files added to the workspace:\n[\s\S]*- The lands \(brand\) \[s_own\]: Every land: Frost Peak is the snowy one\./);
    expect(ctx).toContain("- voice.md [s_all]: not read yet");
    expect(ctx).not.toMatch(/elsewhere|old\.md|bob/);
    expect(await workspaceContext("p-none1", 6000)).toBe("");
    expect(await workspaceContext(undefined, 6000)).toBe("");
  });

  it("names every file, gives whole text up to the budget and names the ones left out (owner 2026-11-17: never dropped silently)", () => {
    const p = { ...project, id: "p", notes: "x".repeat(10_000), createdAt: 1, updatedAt: 1 };
    const files = Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, name: `f${i}.md`, text: `text of f${i}`, addedAt: 1, about: "y".repeat(80) }));
    files.push({ id: "big", name: "big.md", text: "z".repeat(50_000), addedAt: 1, about: "the long one" });
    files.push({ id: "last", name: "last.md", text: "the last file's words", addedAt: 1, about: "short" });
    const small = renderContext(p, files, 3000);
    // a small call: instructions shortened, but every file is still named and the left-out ones are pointed to the tool
    expect(small).toContain("…[shortened]");
    expect(small.split("\n").filter((l) => l.startsWith("- ")).length).toBe(52);
    expect(small).toMatch(/Not given whole here[^\n]*big\.md \[big\][^\n]*last\.md \[last\][^\n]*workspace_files/);
    expect(small).not.toContain("the last file's words");

    const wide = renderContext(p, files, 40_000);
    // the big file is past the budget: named, not loaded; the smaller ones after it still go in whole
    expect(wide).toContain("### last.md [last]\nthe last file's words");
    expect(wide).toContain("### f49.md [f49]\ntext of f49");
    expect(wide).not.toContain("z".repeat(100));
    expect(wide).toMatch(/Not given whole here[^\n]*: big\.md \[big\]\. Read one with the workspace_files tool/);
    expect(wide.length).toBeLessThanOrEqual(40_000);
  });
});
