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

  it("fits in what the call can carry: the files keep a third when the instructions are long, whole lines only", () => {
    const p = { ...project, id: "p", notes: "x".repeat(10_000), createdAt: 1, updatedAt: 1 };
    const files = Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, name: `f${i}.md`, text: "", addedAt: 1, about: "y".repeat(80) }));
    const out = renderContext(p, files, 3000);
    expect(out.length).toBeLessThanOrEqual(3000);
    expect(out).toContain("…[shortened]");
    expect(out).toMatch(/- f0\.md \[f0\]: y+\n/);
    expect(out.split("\n").filter((l) => l.startsWith("- f")).every((l) => l.endsWith("y"))).toBe(true);
    // short instructions leave the files the rest
    expect(renderContext({ ...p, notes: "short" }, files, 3000).split("\n").filter((l) => l.startsWith("- f")).length).toBeGreaterThan(20);
  });
});
