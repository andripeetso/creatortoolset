import { describe, expect, it } from "vitest";
import type { AssetCard, Collection } from "@contracts/library";
import { putBack, rollOfFolder, takeOut } from "./moves";

const card = (id: string) => ({ id }) as AssetCard;
const ids = (all: AssetCard[]) => all.map((a) => a.id);

describe("moves on screen", () => {
  it("cards taken out go back in their places, once", () => {
    const all = ["a", "b", "c", "d"].map(card);
    const { rest, taken } = takeOut(all, ["b", "d"]);
    expect(ids(rest)).toEqual(["a", "c"]);
    expect(ids(putBack(rest, taken))).toEqual(["a", "b", "c", "d"]);
    expect(ids(putBack(putBack(rest, taken), taken))).toEqual(["a", "b", "c", "d"]);
    expect(ids(putBack([card("a")], taken))).toEqual(["a", "b", "d"]); // the list got shorter meanwhile: at its end
  });

  it("only a saved search of a roll and nothing else is a roll folder", () => {
    const smart = (query: Collection["query"]) => ({ id: "x", name: "x", parentId: null, kind: "smart", query, createdBy: "" }) as Collection;
    expect(rollOfFolder(smart({ roll: "a" }))).toBe("a");
    expect(rollOfFolder(smart({ roll: "b", q: "beach" }))).toBeNull();
    expect(rollOfFolder({ ...smart({ roll: "a" }), kind: "manual" })).toBeNull();
    expect(rollOfFolder(undefined)).toBeNull();
  });
});
