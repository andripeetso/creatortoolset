import { describe, expect, it } from "vitest";
import { auditFixCount, claimPlaceLabel, countUnits, docTabLabel, docUnit, editSummary, isAuditFixWhere, isStockDocTitle, liveAuditScore, sessionStatusLabel, sessionStatusOf } from "./workshop";

describe("stock titles", () => {
  it("treats Script, kind names, and numbered copies as stock", () => {
    expect(isStockDocTitle("Script")).toBe(true);
    expect(isStockDocTitle("Script 2")).toBe(true);
    expect(isStockDocTitle("Reel")).toBe(true);
    expect(isStockDocTitle("Carousel")).toBe(true);
    expect(isStockDocTitle("Ad copy")).toBe(true);
    expect(isStockDocTitle("Draft")).toBe(true);
    expect(isStockDocTitle("Sample")).toBe(false);
  });

  it("shows the kind on the tab when the title is still stock", () => {
    expect(docTabLabel({ title: "Script", kind: "carousel" })).toBe("Carousel");
    expect(docTabLabel({ title: "Reel", kind: "reel" })).toBe("Reel script");
    expect(docTabLabel({ title: "Sample", kind: "carousel" })).toBe("Sample");
  });
});

describe("units", () => {
  it("never says block", () => {
    expect(docUnit("carousel")).toEqual({ one: "slide", many: "slides" });
    expect(docUnit("reel")).toEqual({ one: "script", many: "script" });
    expect(docUnit("ad")).toEqual({ one: "line", many: "lines" });
    expect(countUnits("carousel", 7)).toBe("7 slides");
    expect(countUnits("reel", 1)).toBe("script");
    expect(countUnits("notes", 0)).toBe("notes");
    expect(editSummary("notes", ["b1", "b2"])).toBe("the notes");
  });
});

describe("editSummary", () => {
  it("names the description instead of calling it a beat", () => {
    expect(editSummary("reel", ["caption"])).toBe("the post description");
    expect(editSummary("carousel", ["b1", "caption"])).toBe("1 slide and the post description");
    expect(editSummary("reel", ["h1", "h2"])).toBe("2 hook variations");
    expect(editSummary("reel", ["h1", "b1"])).toBe("1 hook variation and the script");
  });
});

describe("audit places", () => {
  const doc = { kind: "reel" as const, blocks: [{ id: "b1" }, { id: "b6" }] };
  it("names the script, caption, and pinned comment instead of raw ids", () => {
    expect(claimPlaceLabel({ kind: "notes", blocks: [{ id: "b1" }] }, "b1")).toBe("Notes");
    expect(claimPlaceLabel(doc, "caption")).toBe("Post description");
    expect(claimPlaceLabel(doc, "pinned")).toBe("Pinned comment");
    expect(claimPlaceLabel(doc, "b1")).toBe("Script");
    expect(claimPlaceLabel({ ...doc, hooks: [{ id: "h1" }] }, "h1")).toBe("Hook 1");
    expect(isAuditFixWhere("h1")).toBe(true);
    expect(isAuditFixWhere("caption")).toBe(true);
    expect(isAuditFixWhere("slide 2")).toBe(false);
  });
  it("counts unapplied wording", () => {
    expect(
      auditFixCount({
        target: { type: "document", id: "d1", title: "Reel" },
        depth: "quick",
        result: {
          score: 70,
          summary: "",
          claims: [
            { id: "c1", where: "b1", claim: "x", verdict: "partly", confidence: 0.8, evidence: "", sources: [], fix: "y" },
            { id: "c2", where: "b6", claim: "x", verdict: "supported", confidence: 0.9, evidence: "", sources: [] },
          ],
          citations: [],
        },
        applied: ["c1"],
      }),
    ).toBe(0);
  });
  it("raises the score when a rewording is applied", () => {
    const audit = {
      target: { type: "document" as const, id: "d1", title: "Reel" },
      depth: "quick" as const,
      result: {
        score: 70,
        summary: "",
        claims: [
          { id: "c1", where: "b1", claim: "x", verdict: "partly" as const, confidence: 0.8, evidence: "", sources: [], fix: "y" },
          { id: "c2", where: "b6", claim: "x", verdict: "supported" as const, confidence: 0.9, evidence: "", sources: [] },
        ],
        citations: [] as string[],
      },
    };
    expect(liveAuditScore(audit)).toBe(70);
    expect(liveAuditScore({ ...audit, applied: ["c1"] })).toBe(100);
  });
  it("does not treat skipped or unverifiable claims as supported", () => {
    expect(
      liveAuditScore({
        applied: ["c1"],
        result: {
          score: 40,
          summary: "",
          claims: [
            { id: "c1", where: "b1", claim: "x", verdict: "contradicted", confidence: 0.9, evidence: "", sources: [], fix: "y" },
            { id: "c2", where: "b2", claim: "x", verdict: "unverifiable", confidence: 0.4, evidence: "", sources: [] },
          ],
          citations: [],
        },
      }),
    ).toBe(63);
  });
});

describe("session status", () => {
  it("treats a missing mark as Idea", () => {
    expect(sessionStatusOf(undefined)).toBe("draft");
    expect(sessionStatusLabel(undefined)).toBe("Idea");
    expect(sessionStatusLabel("production")).toBe("In Production");
  });
});
