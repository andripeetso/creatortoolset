import { describe, expect, it } from "vitest";
import { assetTitle, cutOf, isFinished, versionLabel, type ReviewAsset } from "./review";

const asset = (...createdAt: number[]) => ({ versions: createdAt.map((t) => ({ createdAt: t })) }) as ReviewAsset;
const marked = (finished: boolean, at: number, ...createdAt: number[]) =>
  ({ ...asset(...createdAt), done: { finished, at } }) as ReviewAsset;

describe("isFinished (marked by hand, until a newer version)", () => {
  it("follows the mark, and a new version reopens it", () => {
    expect(isFinished(marked(true, 100, 50))).toBe(true);
    expect(isFinished(marked(false, 100, 50))).toBe(false);
    expect(isFinished(marked(true, 100, 50, 120))).toBe(false);
    expect(isFinished(asset(50))).toBe(false); // no mark: not finished
  });
});

describe("AI Editor cuts in the editor's words", () => {
  it("reads Draft N and the version from new and old cut names", () => {
    expect(cutOf("ApologyVideoButStandalone_A_D6.mp4")).toEqual({ title: "ApologyVideoButStandalone", draft: 6, letter: "A" });
    expect(cutOf("Handstand_basics_D2")).toEqual({ title: "Handstand basics", draft: 2, letter: "" });
    // before 2026-11-20: V<round><letter>_D<save>, the round is the draft
    expect(cutOf("Tiny_V2B_D3.mp4")).toEqual({ title: "Tiny", draft: 2, letter: "B" });
    expect(cutOf("holiday.mov")).toBeNull();
  });
  it("labels versions as drafts, and any other upload as V<n>", () => {
    expect(versionLabel({ n: 8, name: "Tiny_A_D6.mp4" })).toBe("Draft 6");
    expect(versionLabel({ n: 3, name: "Tiny v1.mp4", draft: { edit: "e", name: "v1" } })).toBe("Draft 3");
    expect(versionLabel({ n: 2, name: "holiday.mov" })).toBe("V2");
  });
  it("titles a video named after its newest cut by its title and version", () => {
    expect(assetTitle("ApologyVideoButStandalone_A_D6")).toBe("ApologyVideoButStandalone · Version A");
    expect(assetTitle("Handstand_basics_D2")).toBe("Handstand basics");
    expect(assetTitle("My holiday")).toBe("My holiday");
  });
});
