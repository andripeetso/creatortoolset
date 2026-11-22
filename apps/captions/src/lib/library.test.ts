import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import { addRefused, cardsOfVersions, changeFolderItems, clearPieceCover, getPiece, libraryNews, listAllAssets, macIndexOnly, patchPieceItem, reorderedPositions, setPieceCover, uploadFile, uploadFinal } from "./library";

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

  it("a Mac-app drop sends nothing unless Hosted media says so, so it is indexed in place (macIndexOnly); a browser or Hosted media on is not", async () => {
    const libs = (upload: string) => vi.fn(async () => new Response(JSON.stringify({ libraries: [{ id: "lib_1", settings: { upload } }] })));
    mac(picked);
    // the Mac app's page mark (the one canReveal reads): without it the bridge alone is not the Mac app's page
    vi.stubGlobal("document", { documentElement: { dataset: { macReveal: "1" } } });
    vi.stubGlobal("fetch", libs("none"));
    expect(await macIndexOnly("lib_1")).toBe(true);
    vi.stubGlobal("fetch", libs("all"));
    expect(await macIndexOnly("lib_1")).toBe(false);
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    vi.stubGlobal("fetch", libs("none"));
    expect(await macIndexOnly("lib_1")).toBe(false);
    vi.stubGlobal("window", {});
    const browser = libs("none");
    vi.stubGlobal("fetch", browser);
    expect(await macIndexOnly("lib_1")).toBe(false);
    expect(browser).not.toHaveBeenCalled();
    // a library the list does not have is not index-in-place either (its upload is unknown)
    mac(picked);
    vi.stubGlobal("document", { documentElement: { dataset: { macReveal: "1" } } });
    vi.stubGlobal("fetch", libs("none"));
    expect(await macIndexOnly("other_lib")).toBe(false);
  });

  it("a member's add is refused only with Hosted media Off; the owner's is never refused", () => {
    const lib = (upload: string, readOnly?: true) => ({ id: "lib_1", settings: { upload }, readOnly }) as unknown as LibrarySummary;
    expect(addRefused(lib("none", true))).toBe(true);
    expect(addRefused(lib("proxies", true))).toBe(false);
    expect(addRefused(lib("none"))).toBe(false);
    expect(addRefused(null)).toBe(false);
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

  it("an upload says where the file is on this Mac and which Mac (proxies only keeps that place, not the original)", async () => {
    mac({ ...picked, device: "dev_1" });
    const starts: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/in-place")) return new Response(JSON.stringify({ code: "forbidden" }), { status: 403 });
      if (url.endsWith("/uploads")) return starts.push(JSON.parse(String(init!.body))), new Response(JSON.stringify({ id: "u1", offset: 0, chunkSize: 1 << 20 }), { status: 201 });
      if (url.endsWith("/finish")) return new Response(JSON.stringify({ assetId: "a3" }));
      return new Response(null, { status: 204, headers: { "upload-offset": "5000" } });
    });
    expect(await uploadFile("lib_1", clip(), () => {})).toEqual({ assetId: "a3" });
    // and that this Mac may send it itself: its quick fingerprint, so a server that lets it sends no bytes from here
    expect(starts).toEqual([{ filename: "C0001.MP4", size: 5000, fromPath: "/Volumes/Card/C0001.MP4", fromDevice: "dev_1", quick: expect.stringMatching(/^[0-9a-f]{64}$/), send: true }]);
  });

  it("sends no bytes when the server lets this Mac send the file itself (its proxy, not the original)", async () => {
    mac({ ...picked, device: "dev_1" });
    const urls: string[] = [];
    const told: number[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.endsWith("/in-place")) return new Response(JSON.stringify({ code: "forbidden" }), { status: 403 });
      return new Response(JSON.stringify({ assetId: "a4", versionId: "v4", sent: true }));
    });
    expect(await uploadFile("lib_1", clip(), (sent) => told.push(sent))).toEqual({ assetId: "a4" });
    expect(urls.filter((u) => !u.endsWith("/in-place"))).toEqual(["/api/library/lib_1/uploads"]);
    expect(told.at(-1)).toBe(5000); // after the in-place attempt's own 0s
  });

  it("under Upload none (onMac) a Mac-app drop never posts to /uploads: in place, indexed on this Mac, or refused where its path is unknown", async () => {
    mac(picked);
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/in-place") ? new Response("{}", { status: 400 }) : Response.json({ assetId: "a1" })));
    vi.stubGlobal("fetch", fetchMock);
    // the drop's own path, the server refuses the in-place add: indexed on this Mac, nothing sent
    expect(await uploadFile("lib_1", clip(), () => {}, undefined, "/Volumes/Card/C0001.MP4", { onMac: true })).toEqual({ assetId: "a1" });
    // a file whose place on this Mac is unknown: refused, never uploaded
    await expect(uploadFile("lib_1", new File([new Uint8Array(9)], "Other.MP4"), () => {}, undefined, undefined, { onMac: true })).rejects.toThrow("Not added");
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(["/api/library/lib_1/in-place", "/api/library/lib_1/on-mac"]);
    expect(urls.some((url) => /\/uploads(\?|$)/.test(url))).toBe(false);
  });

  it("Add final under Upload none (no onMac) still reaches the server: a remote server refuses the in-place add, so the file uploads", async () => {
    mac(picked);
    vi.stubGlobal("document", { documentElement: { dataset: { macReveal: "1" } } });
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/in-place") ? new Response("{}", { status: 403 }) : Response.json({ assetId: "a2", versionId: "v2" })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await uploadFile("lib_1", clip(), () => {}, "finals_1", "/Volumes/Card/C0001.MP4")).toEqual({ assetId: "a2", versionId: "v2" });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => /\/uploads(\?|$)/.test(url))).toBe(true);
  });

  it("Add final copied into its folder on this Mac, Upload none, the Mac app's page (uploadFinal): the server still gets it; only Finals none keeps it here", async () => {
    mac({ ...picked, device: "dev_1" });
    vi.stubGlobal("document", { documentElement: { dataset: { macReveal: "1" } } });
    const copied = "/Volumes/Tiny/Finals/Tiny Acrobatics handstand/C0001.MP4";
    const urls: string[] = [];
    const starts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (url === "/api/library") return Response.json({ libraries: [{ id: "lib_1", settings: { upload: "none" } }] });
      if (url.endsWith("/in-place")) return new Response("{}", { status: 403 });
      // a Mac the server does not let send it (an older Mac app): an upload to fill with the bytes
      if (url.endsWith("/uploads")) return starts.push(JSON.parse(String(init!.body))), new Response(JSON.stringify({ id: "u1", offset: 0, chunkSize: 1 << 20 }), { status: 201 });
      if (url.endsWith("/finish")) return Response.json({ assetId: "fin1" });
      if (url.endsWith("/on-mac")) return Response.json({ assetId: "here1" });
      return new Response(null, { status: 204, headers: { "upload-offset": "5000" } });
    });
    expect(await uploadFinal("lib_1", clip(), copied, "all", "finals_1", () => {})).toEqual({ assetId: "fin1" });
    expect(urls.filter((u) => !u.endsWith("/in-place"))).toEqual(["/api/library/lib_1/uploads", "/api/library/uploads/u1", "/api/library/uploads/u1/finish"]);
    expect(starts).toMatchObject([{ collectionId: "finals_1", fromPath: copied, fromDevice: "dev_1", send: true }]);
    // the Finals setting none: read where it was copied, nothing sent
    urls.length = 0;
    expect(await uploadFinal("lib_1", clip(), copied, "none", "finals_1", () => {})).toEqual({ assetId: "here1" });
    expect(urls).toEqual(["/api/library/lib_1/on-mac"]);
  });

  it("keeps the server's code on a refusal, so the page shows no Retry for a file too large for this server", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "This file is 12 GB. This server takes files up to 8 GB.", code: "too_large" }), { status: 413 }));
    await expect(uploadFile("lib_1", clip(), () => {})).rejects.toMatchObject({ message: expect.stringContaining("12 GB"), code: "too_large" });
  });
});

describe("changeFolderItems", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends a big selection whole, in one request, so it moves all of it or none", async () => {
    const sizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const n = (JSON.parse(String(init.body)) as { assetIds: string[] }).assetIds.length;
      sizes.push(n);
      return new Response(JSON.stringify({ added: n }), { status: 200 });
    }));
    const ids = Array.from({ length: 1100 }, (_, i) => `ast_${i}`);
    expect(await changeFolderItems("lib_1", "col_1", ids, true)).toEqual({ added: 1100 });
    expect(sizes).toEqual([1100]);
  });
});

describe("listAllAssets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads from the cursor given to the last page, in the largest pages, keeping the view's query", async () => {
    const pages = [
      { items: [{ id: "ast_2" }], next: "c3" },
      { items: [{ id: "ast_3" }], next: undefined },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(pages.shift()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const got = await listAllAssets("lib_1", { roll: "b", cursor: "c2" });
    expect(got.map((a) => a.id)).toEqual(["ast_2", "ast_3"]);
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([u]) => new URL(u, "http://x").searchParams);
    expect(urls.map((p) => p.get("cursor"))).toEqual(["c2", "c3"]);
    expect(urls.every((p) => p.get("limit") === "200" && p.get("roll") === "b")).toBe(true);
  });
});

describe("cardsOfVersions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the versions (finished clips are only listed by id), at most 200 a request, and asks nothing for none", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "ast" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: 201 }, (_, n) => `v${n}`);
    expect(await cardsOfVersions("lib_1", [...ids, "v0"])).toHaveLength(2);
    const asked = (fetchMock.mock.calls as unknown as [string][]).map(([u]) => new URL(u, "http://x").searchParams.get("versions")!.split(","));
    expect(asked.map((v) => v.length)).toEqual([200, 1]);
    fetchMock.mockClear();
    expect(await cardsOfVersions("lib_1", [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
