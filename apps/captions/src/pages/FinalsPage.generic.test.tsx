import { existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { AssetCard, Piece } from "@contracts/library";
import { libraryBadges, libraryFacets } from "@/lib/library-slots";
import { FinalsView, finalsTiles } from "./FinalsPage";

// With no plug-in folder the Finals page is the generic one: no facet group, no badge. With a plug-in folder
// present, the plug-in adds facets, so the check is skipped there (the rest still runs).
const withPlugin = existsSync(new URL("../../plugins/baby-acrobatics", import.meta.url));
const card: AssetCard = {
  id: "a",
  libraryId: "lib_tiny",
  kind: "video",
  title: "a",
  versionId: "v-a",
  versionN: 1,
  tags: [],
  aiTags: [],
  state: "ready",
};
const piece: Piece = {
  id: "reel",
  label: "Piece reel",
  collectionId: "col_f",
  createdBy: "owner",
  items: [{ id: "i-a", label: null, position: 1, winner: true, versionId: "v-a", externalRef: null, postDescription: null, postings: [] }],
};

describe("Finals page with no plug-ins", () => {
  it.skipIf(withPlugin)("has no plug-in facets or badges", () => {
    expect(libraryFacets("library")).toEqual([]);
    expect(libraryFacets("finals")).toEqual([]);
    expect(libraryBadges(card)).toEqual([]);
  });

  it("draws the kind tiles and the piece, and no facet group", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinalsView hasFinals pieces={[piece]} cards={[card]} picked={{}} onFacets={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-label="Kind"');
    expect(html).toContain("Piece reel");
    expect(html).not.toContain("aria-label=\"Tiny");
  });
});

describe("Finals tiles", () => {
  it("shows the owner's picked cover before the winner's thumbnail", () => {
    const tiles = finalsTiles([{ ...piece, coverUrl: "/api/library/lib_tiny/pieces/reel/cover?v=7" }], [card], false);
    expect(tiles[0].cover).toBe("/api/library/lib_tiny/pieces/reel/cover?v=7");
    expect(finalsTiles([piece], [card], false)[0].cover).toBe("/api/library/media/v-a/thumb");
  });
});
