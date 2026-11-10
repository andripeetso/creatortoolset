import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPieceCover, getPiece, libraryNews, patchPieceItem, reorderedPositions, setPieceCover } from "./library";

describe("reorderedPositions", () => {
  const items = [
    { id: "a", position: 1 },
    { id: "b", position: 2 },
    { id: "c", position: 3 },
  ];

  it("moves an item down and renumbers only the items that changed", () => {
    expect(reorderedPositions(items, 0, 2)).toEqual([
      { id: "b", position: 1 },
      { id: "c", position: 2 },
      { id: "a", position: 3 },
    ]);
  });

  it("moves an item up by one (the move buttons)", () => {
    expect(reorderedPositions(items, 2, 1)).toEqual([
      { id: "c", position: 2 },
      { id: "b", position: 3 },
    ]);
  });

  it("returns nothing for a drop on itself or an index off the list", () => {
    expect(reorderedPositions(items, 1, 1)).toEqual([]);
    expect(reorderedPositions(items, 0, 3)).toEqual([]);
    expect(reorderedPositions(items, -1, 0)).toEqual([]);
  });

  it("renumbers gaps left by removed items, so every position is 1..n", () => {
    expect(reorderedPositions([{ id: "a", position: 1 }, { id: "b", position: 5 }], 1, 0)).toEqual([
      { id: "b", position: 1 },
      { id: "a", position: 2 },
    ]);
  });
});

describe("patchPieceItem", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the change to the item's route and returns the piece the server answers with", async () => {
    const piece = { id: "pce_1", label: "Tiny reel", items: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(piece), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await patchPieceItem("lib_1", "pce_1", "pci_9", { winner: true, postDescription: "Tiny post" });
    expect(out).toEqual(piece);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/library/lib_1/pieces/pce_1/items/pci_9");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ winner: true, postDescription: "Tiny post" });
  });

  it("throws the server's message when the change is refused", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));
    await expect(patchPieceItem("lib_1", "pce_1", "pci_9", { winner: true })).rejects.toThrow("Not found");
  });
});

describe("piece reads and cover", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads one piece, and sends the cover pick and the clear to the cover route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "pce_1", items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getPiece("lib_1", "pce_1");
    await setPieceCover("lib_1", "pce_1", "ver_9", 2.5);
    await clearPieceCover("lib_1", "pce_1");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit | undefined][];
    expect(calls.map(([url]) => url)).toEqual([
      "/api/library/lib_1/pieces/pce_1",
      "/api/library/lib_1/pieces/pce_1/cover",
      "/api/library/lib_1/pieces/pce_1/cover",
    ]);
    expect(calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST", "DELETE"]);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ versionId: "ver_9", t: 2.5 });
  });
});

describe("libraryNews (useLibraryChanges)", () => {
  it("skips the tab's first hello and a notice it has seen, refetches on a newer change or a restarted server", () => {
    expect(libraryNews({ seq: 0, boot: "" }, 7, "b1")).toBe(false);
    expect(libraryNews({ seq: 7, boot: "b1" }, 7, "b1")).toBe(false);
    expect(libraryNews({ seq: 7, boot: "b1" }, 8, "b1")).toBe(true);
    expect(libraryNews({ seq: 7, boot: "b1" }, 2, "b2")).toBe(true);
  });
});
