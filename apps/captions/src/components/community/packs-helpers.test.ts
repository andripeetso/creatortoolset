import { describe, expect, it } from "vitest";
import { countLabel, destinations, firstSentence, packContents, packKinds, packProjects, slugify, toolLine } from "./packs-helpers";

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
    expect(packContents({})).toEqual({ slots: [], frameworks: [], captionStyles: [], skills: [], home: null });
  });

  it("names the tools a Home layout shows, and files the pack under Home layouts", () => {
    const home = { hidden: ["enhance", "captions", "clean", "stories", "notes", "guides", "record"] as never };
    expect(packContents({ home }).home).toEqual(["Content Analyzer", "Content Workshop", "Media Library", "AI Editor", "Review"]);
    expect(packKinds({ instructions: [], frameworks: 0, captionStyles: 0, designSystems: 0, home: true })).toEqual([{ id: "home", label: "Home layouts", count: undefined }]);
    expect(destinations({ instructions: [], frameworks: 0, captionStyles: 0, designSystems: 0, home: true }).map((d) => d.to)).toEqual(["/settings/tools"]);
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

describe("where a pack goes", () => {
  it("maps frameworks, guides and styles to their tool and spot, and leaves out what this app doesn't read", () => {
    const c = { instructions: ["workshop.write" as const, "editor.cards" as const], frameworks: 3, captionStyles: 2, designSystems: 1 };
    expect(destinations(c).map((x) => `${x.stage} ${x.tool} › ${x.spot}`)).toEqual([
      "Plan Content Workshop › A piece's Shape menu",
      "Plan Content Workshop › Every message to the AI on a piece",
      "Make Caption Studio › The style list when you caption a video",
    ]);
    expect(toolLine(c)).toBe("Plan · Content Workshop, Make · Caption Studio");
  });
});

describe("firstSentence", () => {
  it("is the first sentence when it fits a row, so the line ends cleanly", () => {
    expect(firstSentence("Writing frame for hooks. It reads your last ten posts and then asks what you want to say.")).toBe("Writing frame for hooks.");
    expect(firstSentence("Does it work? Yes.")).toBe("Does it work?");
  });
  it("is empty when there is no full sentence or it is too long for one line (the fold keeps the rest)", () => {
    expect(firstSentence("No full stop here")).toBe("");
    expect(firstSentence(`${"word ".repeat(30)}end.`)).toBe("");
  });
});
