import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssetCard, Piece, PieceItem } from "@contracts/library";
import { PieceEditor } from "./FinalsPiece";

const card = (versionId: string, title: string, o: Partial<AssetCard> = {}): AssetCard => ({
  id: `ast_${versionId}`,
  libraryId: "lib_tiny",
  kind: "video",
  title,
  versionId,
  versionN: 1,
  tags: [],
  aiTags: [],
  state: "ready",
  ...o,
});

const item = (id: string, versionId: string, o: Partial<PieceItem> = {}): PieceItem => ({
  id,
  label: null,
  position: 1,
  winner: false,
  versionId,
  externalRef: null,
  postDescription: null,
  postings: [],
  ...o,
});

const cards = [card("v-a", "Tiny take A"), card("v-b", "Tiny take B"), card("v-c", "Tiny take C")];

const render = (piece: Piece) =>
  renderToStaticMarkup(<PieceEditor libraryId="lib_tiny" piece={piece} cards={cards} onPiece={() => {}} onGone={() => {}} />);

describe("FinalsPiece editor", () => {
  const piece: Piece = {
    id: "pce_tiny",
    label: "Tiny reel",
    collectionId: "col_f",
    createdBy: "owner",
    items: [
      item("pci_2", "v-b", { position: 1, label: "Second take" }),
      item("pci_1", "v-a", {
        position: 2,
        winner: true,
        postDescription: "Tiny post text",
        postings: [{ id: 7, platform: "instagram", url: "https://example.com/p/1", postedAt: 1, createdBy: "owner" }],
      }),
    ],
  };

  it("lists the versions in the order the server gives (drag order)", () => {
    const html = render(piece);
    expect(html.indexOf("Second take")).toBeGreaterThan(-1);
    expect(html.indexOf("Second take")).toBeLessThan(html.indexOf("Tiny take A"));
  });

  it("marks exactly the winner and uses its frame as the cover", () => {
    const html = render(piece);
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('src="/api/library/media/v-a/thumb"');
  });

  it("shows each version's post description and postings", () => {
    const html = render(piece);
    expect(html).toContain("Tiny post text");
    expect(html).toContain("Instagram");
    expect(html).toContain('href="https://example.com/p/1"');
  });

  it("uses the frame the owner picked as the cover, and offers the picker only when the account can change the piece", () => {
    const picked = { ...piece, coverUrl: "/api/library/lib_tiny/pieces/pce_tiny/cover?v=5" };
    const html = render(picked);
    expect(html).toContain('src="/api/library/lib_tiny/pieces/pce_tiny/cover?v=5"');
    expect(html).toContain("Back to the automatic cover");
    expect(html).toContain("Use this frame as cover");
  });

  it("is read only when some item is not visible to the account: no controls, one line", () => {
    const html = renderToStaticMarkup(
      <PieceEditor libraryId="lib_tiny" piece={piece} cards={cards} readOnly onPiece={() => {}} onGone={() => {}} />,
    );
    expect(html).toContain("Read only");
    expect(html).not.toContain("Use this frame as cover");
    expect(html).not.toMatch(/<(button|select|input|textarea)(?![^>]*disabled)/); // every control is rendered disabled
  });

  it("saves the piece as one ZIP link, also when it is read only, and not for an empty piece", () => {
    expect(render(piece)).toContain('href="/api/library/lib_tiny/pieces/pce_tiny/zip" download=""');
    const readOnly = renderToStaticMarkup(
      <PieceEditor libraryId="lib_tiny" piece={piece} cards={cards} readOnly onPiece={() => {}} onGone={() => {}} />,
    );
    expect(readOnly).toContain("Save all as ZIP");
    expect(render({ ...piece, items: [] })).not.toContain("Save all as ZIP");
  });

  it("offers only the library's versions that are not in the piece yet", () => {
    const html = render(piece);
    expect(html).toContain("Tiny take C");
    expect(html).not.toContain("<option value=\"v-a\"");
    expect(html).not.toContain("<option value=\"v-b\"");
  });
});
