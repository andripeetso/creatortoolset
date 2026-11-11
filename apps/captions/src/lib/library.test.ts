import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPieceCover, getPiece, libraryNews, patchPieceItem, reorderedPositions, setPieceCover, uploadFile } from "./library";

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

describe("uploadFile from the Mac app on its own server", () => {
  afterEach(() => vi.unstubAllGlobals());
  const clip = () => new File([new Uint8Array(5000)], "C0001.MP4", { lastModified: 1_700_000_000_000 });
  const mac = (answer: unknown) => vi.stubGlobal("window", { webkit: { messageHandlers: { thisMac: { postMessage: async () => answer } } } });
  const picked = { files: [{ path: "/Volumes/Card/C0001.MP4", name: "C0001.MP4", size: 5000, modified: 1_700_000_000_000 }] };

  it("adds a picked file where it is, asks again while the server still reads it, and sends no bytes", async () => {
    mac(picked);
    const answers = [new Response(JSON.stringify({ working: true }), { status: 202 }), new Response(JSON.stringify({ assetId: "a1", versionId: "v1" }))];
    const fetchMock = vi.fn(async () => answers.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const told: [number, boolean | undefined][] = [];
    expect(await uploadFile("lib_1", clip(), (sent, inPlace) => told.push([sent, inPlace]), "col_1")).toEqual({ assetId: "a1", versionId: "v1" });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual(["/api/library/lib_1/in-place", "/api/library/lib_1/in-place"]);
    expect(calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { path: "/Volumes/Card/C0001.MP4", size: 5000, collectionId: "col_1", again: false },
      { path: "/Volumes/Card/C0001.MP4", size: 5000, collectionId: "col_1", again: true },
    ]);
    expect(told).toEqual([[0, true]]);
  });

  it("uploads as before in an older Mac app, which answers the question with its state, and when the server says to", async () => {
    for (const [answer, inPlace] of [
      [{ aiOn: false, paired: false }, null], // an older Mac app: no files in its answer
      [picked, new Response(JSON.stringify({ code: "forbidden" }), { status: 403 })], // not this computer's server
    ] as const) {
      mac(answer);
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        urls.push(url);
        if (url.endsWith("/in-place")) return inPlace!;
        if (url.endsWith("/uploads")) return new Response(JSON.stringify({ id: "u1", offset: 0, chunkSize: 1 << 20 }), { status: 201 });
        if (url.endsWith("/finish")) return new Response(JSON.stringify({ assetId: "a2" }));
        return new Response(null, { status: 204, headers: { "upload-offset": "5000" } });
      });
      expect(await uploadFile("lib_1", clip(), () => {})).toEqual({ assetId: "a2" });
      expect(urls.filter((u) => !u.endsWith("/in-place"))).toEqual(["/api/library/lib_1/uploads", "/api/library/uploads/u1", "/api/library/uploads/u1/finish"]);
    }
  });

  it("keeps the server's code on a refusal, so the page shows no Retry for a file too large for this server", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "This file is 12 GB. This server takes files up to 8 GB.", code: "too_large" }), { status: 413 }));
    await expect(uploadFile("lib_1", clip(), () => {})).rejects.toMatchObject({ message: expect.stringContaining("12 GB"), code: "too_large" });
  });
});
