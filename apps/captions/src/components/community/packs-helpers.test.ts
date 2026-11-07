import { describe, expect, it } from "vitest";
import { countLabel, packContents, packKinds, packProjects, slugify } from "./packs-helpers";

describe("packContents", () => {
  it("lists instruction slots in the app's slot order, with their labels, and leaves out ones this app doesn't use", () => {
    const c = packContents({
      instructions: { "editor.cards": "cards text", "editor.script": "script text", "workshop.write": "write text" },
      frameworks: [{ name: "Hook, proof, ask", role: "persuasion", summary: "", steps: [], whenToUse: "" }],
      captionStyles: [{ name: "Bold", kind: "caption", style: {} }],
    });
    expect(c.slots.map((s) => s.slot)).toEqual(["workshop.write", "editor.script"]);
    expect(c.slots[0].label).toBe("Content Workshop: writing and editing pieces");
    expect(c.frameworks).toEqual([{ name: "Hook, proof, ask", role: "persuasion" }]);
    expect(c.captionStyles).toEqual(["Bold"]);
  });

  it("is empty for a pack with nothing in it", () => {
    expect(packContents({})).toEqual({ slots: [], frameworks: [], captionStyles: [] });
  });
});

describe("packKinds", () => {
  it("puts a pack in every section it works in, with counts", () => {
    expect(
      packKinds({ instructions: ["workshop.write", "workshop.review", "editor.script"], frameworks: 21, captionStyles: 0, designSystems: 0 }),
    ).toEqual([
      { id: "frameworks", label: "Writing frameworks", count: 21 },
      { id: "guides", label: "Writing guides", count: 2 },
      { id: "editing", label: "Editing styles", count: 1 },
    ]);
  });

  it("files a caption-lines instruction under caption styles, and ignores what this app doesn't use", () => {
    expect(packKinds({ instructions: ["captions.lines"], frameworks: 0, captionStyles: 0, designSystems: 0 })).toEqual([
      { id: "captions", label: "Caption styles", count: undefined },
    ]);
    expect(packKinds({ instructions: ["editor.cards"], frameworks: 0, captionStyles: 0, designSystems: 2 })).toEqual([]);
  });
});

describe("countLabel and packProjects", () => {
  it("pluralises the count line", () => {
    expect(countLabel(1, "install")).toBe("1 install");
    expect(countLabel(2, "install")).toBe("2 installs");
  });

  it("reads an older one-project install as that project, and none as every project", () => {
    expect(packProjects({ projectIds: ["brand-a", "brand-b"] })).toEqual(["brand-a", "brand-b"]);
    expect(packProjects({ projectId: "brand-a" })).toEqual(["brand-a"]);
    expect(packProjects({})).toEqual([]);
  });
});

describe("slugify", () => {
  it("turns a name into a pack id", () => {
    expect(slugify("  Punchy Hooks, LinkedIn!  ")).toBe("punchy-hooks-linkedin");
  });
});
