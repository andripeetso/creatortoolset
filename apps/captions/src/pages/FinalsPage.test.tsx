import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard, Piece, PieceItem } from "@contracts/library";
import { FinalsView, finalsTiles } from "./FinalsPage";

// A test plug-in standing in for the generated registry (plugins.gen): a facet on both pages, one on the Media Library
// only, and one with no scope (which must count as the Media Library only), plus a badge.
vi.mock("../plugins.gen", () => ({
  webPlugins: [
    {
      id: "tiny",
      library: {
        facets: [
          { key: "tiny", label: "Tiny Facet", values: [{ value: "on", label: "Tiny on" }], scope: "both" },
          { key: "libonly", label: "Library Only Facet", values: [{ value: "x", label: "Library x" }], scope: "library" },
          { key: "defaulted", label: "Defaulted Facet", values: [{ value: "y", label: "Defaulted y" }] },
        ],
        badges: () => [{ label: "Tiny badge" }],
      },
    },
  ],
}));

const card = (id: string, o: Partial<AssetCard> = {}): AssetCard => ({
  id,
  libraryId: "lib_tiny",
  kind: "video",
  title: id,
  versionId: `v-${id}`,
  versionN: 1,
  tags: [],
  aiTags: [],
  state: "ready",
  ...o,
});

const item = (versionId: string, o: Partial<PieceItem> = {}): PieceItem => ({
  id: `i-${versionId}`,
  label: null,
  position: 1,
  winner: false,
  versionId,
  externalRef: null,
  postDescription: null,
  postings: [],
  ...o,
});

const piece = (id: string, items: PieceItem[]): Piece => ({ id, label: `Piece ${id}`, collectionId: "col_f", createdBy: "owner", items });

const reel = piece("reel", [item("v-a", { winner: true })]);
const other = piece("other", [item("v-b", { winner: true })]);
const cards = [card("a", { durationS: 42 }), card("b", { kind: "image" })];

describe("Finals pieces", () => {
  it("sorts each piece into a kind from its winner and its versions", () => {
    const shots = piece("shots", [item("v-c"), item("v-d")]);
    const pics = [card("c", { kind: "image" }), card("d", { kind: "image" })];
    const tiles = finalsTiles([reel, shots], [...cards, ...pics], false);
    expect(tiles.map((t) => [t.piece.id, t.kind])).toEqual([
      ["reel", "reel"],
      ["shots", "carousel"],
    ]);
  });

  it("keeps a piece with no matching card when no facet is picked", () => {
    const orphan = piece("orphan", [item("v-gone")]);
    expect(finalsTiles([orphan], cards, false).map((t) => t.piece.id)).toEqual(["orphan"]);
  });

  it("keeps only the pieces whose versions the facet result holds", () => {
    const orphan = piece("orphan", [item("v-gone")]);
    expect(finalsTiles([reel, other, orphan], [cards[0]], true).map((t) => t.piece.id)).toEqual(["reel"]);
  });
});

describe("FinalsView with a plug-in facet and badge", () => {
  it("draws the plug-in facet group and its badge on the winner's card", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinalsView hasFinals pieces={[reel]} cards={cards} picked={{}} onFacets={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-label="Tiny Facet"');
    expect(html).toContain("Tiny on");
    expect(html).toContain("Tiny badge");
    expect(html).toContain("Piece reel");
  });

  it("shows only the facets whose scope includes Finals", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinalsView hasFinals pieces={[reel]} cards={cards} picked={{}} onFacets={() => {}} />
      </MemoryRouter>,
    );
    expect(html).not.toContain("Library Only Facet");
    expect(html).not.toContain("Defaulted Facet");
  });

  it("ignores a Media Library pick when it narrows Finals", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinalsView hasFinals pieces={[reel, other]} cards={[cards[0]]} picked={{ libonly: ["x"] }} onFacets={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain("Piece reel");
    expect(html).toContain("Piece other");
  });

  it("filters the pieces by a picked facet value", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinalsView hasFinals pieces={[reel, other]} cards={[cards[0]]} picked={{ tiny: ["on"] }} onFacets={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain("Piece reel");
    expect(html).not.toContain("Piece other");
  });
});
