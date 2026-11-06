import { describe, expect, it } from "vitest";
import { isFinished, type ReviewAsset } from "./review";

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
