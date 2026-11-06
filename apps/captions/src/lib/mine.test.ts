import { describe, expect, it } from "vitest";
import { foreignSpans, mineIndex } from "./mine";

const said = mineIndex([
  "When the sample page opens, the cursor moves down the panel and across the rows at the top",
  "and the reader checks each card before it's on",
]);
const marked = (text: string) => foreignSpans(text, said).map(([a, b]) => text.slice(a, b));

describe("not my words", () => {
  it("marks the word the AI slipped in, not the author's run around it", () => {
    expect(marked("Opening wide the sample page opens, the cursor moves down the panel and across the rows at the top")).toEqual(["Opening wide"]);
    expect(marked("Every view needs your display for anything else")).toEqual(["Every view needs your display for anything else"]);
    expect(marked("And the reader checks each card before it's on, which needs a lot more")).toEqual(["which needs a lot more"]);
  });

  it("reads curly apostrophes as the author's", () => {
    expect(marked("and the reader checks each card before it’s on")).toEqual([]);
  });
});
