import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard, Piece, PieceItem } from "@contracts/library";
import { addPieceItem, getAsset, uploadFile } from "@/lib/library";
import { PieceEditor, platformOfLink, uploadVersions } from "./FinalsPiece";

vi.mock("@/lib/library", async (real) => ({
  ...(await real<typeof import("@/lib/library")>()),
  uploadFile: vi.fn(),
  getAsset: vi.fn(),
  addPieceItem: vi.fn(),
}));

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
    expect(html).toContain("Reset cover");
    expect(html).toContain("Use frame as cover");
  });

  it("is read only when some item is not visible to the account: no controls, one line", () => {
    const html = renderToStaticMarkup(
      <PieceEditor libraryId="lib_tiny" piece={piece} cards={cards} readOnly onPiece={() => {}} onGone={() => {}} />,
    );
    expect(html).toContain("Read only");
    expect(html).not.toContain("Use frame as cover");
    // every control is rendered disabled; picking which version to look at (data-pick) changes nothing
    expect(html).not.toMatch(/<(button|select|input|textarea)(?![^>]*(disabled|data-pick))/);
  });

  it("saves the piece as one ZIP link, also when it is read only, and not for an empty piece", () => {
    expect(render(piece)).toContain('href="/api/library/lib_tiny/pieces/pce_tiny/zip" download=""');
    const readOnly = renderToStaticMarkup(
      <PieceEditor libraryId="lib_tiny" piece={piece} cards={cards} readOnly onPiece={() => {}} onGone={() => {}} />,
    );
    expect(readOnly).toContain(" Download</a>");
    expect(render({ ...piece, items: [] })).not.toContain(" Download</a>");
  });

  it("shows one version without a list, winner or reorder: just its player, cover and post", () => {
    const html = render({ ...piece, items: [piece.items[1]] });
    expect(html).not.toContain('aria-label="Versions"');
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain("Tiny post text");
  });

  it("offers a new version from a file, a share link, and the post link in a row like the Content Workshop's", () => {
    const html = render(piece);
    expect(html).toContain("Add version");
    expect(html).toContain("Share");
    expect(html).toContain('aria-label="Posts"');
    expect(html).toContain('aria-label="Content Workshop"');
    expect(html).toContain("Posted on Instagram");
  });

  it("shows a carousel one slide at a time, with its count and dots, and calls its parts slides", () => {
    const slides = [card("s-1", "Tiny slide 1", { kind: "image" }), card("s-2", "Tiny slide 2", { kind: "image" }), card("s-3", "Tiny slide 3", { kind: "image" })];
    const carousel: Piece = { ...piece, items: slides.map((c, i) => item(`pci_s${i}`, c.versionId!, { position: i + 1, winner: i === 0 })) };
    const html = renderToStaticMarkup(<PieceEditor libraryId="lib_tiny" piece={carousel} cards={slides} onPiece={() => {}} onGone={() => {}} />);
    expect(html).toContain('aria-label="Slides"');
    expect(html).toContain("1 / 3");
    expect(html).toContain("3 slides");
    expect(html).toContain("Add slide");
    expect(html).toContain('aria-label="Next slide"');
    expect(html).not.toContain('aria-label="Previous slide"');
    for (const c of slides) expect(html).toContain(`src="/api/library/media/${c.versionId}/play"`);
  });

  it("marks a piece as posted from its window until it is posted", () => {
    const fresh = { ...piece, items: piece.items.map((i) => ({ ...i, postings: [] })) };
    expect(render(fresh)).toContain("Mark as posted");
    expect(render(piece)).not.toContain("Mark as posted");
  });

  it("offers no raw footage to add: a piece's versions come from Review, exports and the Content Workshop", () => {
    expect(render(piece)).not.toContain("Tiny take C");
  });
});

describe("platformOfLink", () => {
  it("names the platform a post link is on, and nothing for another site", () => {
    expect(platformOfLink("https://www.instagram.com/reel/abc/")).toBe("instagram");
    expect(platformOfLink("https://youtu.be/abc")).toBe("youtube");
    expect(platformOfLink("https://m.facebook.com/tinyacrobatics/videos/1")).toBe("facebook");
    expect(platformOfLink("https://www.tiktok.com/@tinyacrobatics/video/1")).toBe("tiktok");
    expect(platformOfLink("https://twitter.com/tinyacrobatics/status/1")).toBe("x");
    expect(platformOfLink("https://notinstagram.com/p/1")).toBeUndefined();
    expect(platformOfLink("not a link")).toBeUndefined();
  });
});

describe("uploadVersions", () => {
  const piece = { id: "pce_tiny", label: "Tiny reel", collectionId: "col_f", createdBy: "owner", items: [] } as Piece;
  const file = (name: string) => new File(["x"], name, { type: "video/mp4" });

  it("uploads each file into the piece's collection and adds its clip's version to the piece", async () => {
    vi.mocked(uploadFile).mockReset().mockResolvedValueOnce({ assetId: "ast_1" }).mockResolvedValueOnce({ duplicateOf: "ast_2" });
    vi.mocked(getAsset).mockReset().mockImplementation(async (_l, id) => ({ versionId: `ver_${id}` }) as never);
    vi.mocked(addPieceItem).mockReset().mockImplementation(async (_l, _p, v) => ({ ...piece, items: [{ versionId: v }] }) as never);
    const out = await uploadVersions("lib_tiny", piece, [file("a.mp4"), file("b.mp4")], () => {});
    expect(vi.mocked(uploadFile).mock.calls.map((c) => c[3])).toEqual(["col_f", "col_f"]);
    expect(vi.mocked(addPieceItem).mock.calls.map((c) => c[2])).toEqual(["ver_ast_1", "ver_ast_2"]);
    expect(out?.items[0].versionId).toBe("ver_ast_2");
  });

  it("stops with an error at a file that gives no clip, and adds nothing for it", async () => {
    vi.mocked(uploadFile).mockReset().mockResolvedValueOnce({ duplicate: true });
    vi.mocked(addPieceItem).mockReset();
    await expect(uploadVersions("lib_tiny", piece, [file("a.mp4"), file("b.mp4")], () => {})).rejects.toThrow("Could not upload a.mp4");
    expect(addPieceItem).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });
});
