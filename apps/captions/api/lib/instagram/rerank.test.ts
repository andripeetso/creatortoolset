import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../jev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev")>()),
  ask: vi.fn(),
}));

import { ask } from "../jev";
import { applyRelevance, relevance } from "./rerank";

beforeEach(() => vi.clearAllMocks());

describe("re-ranking a descriptive search", () => {
  it("asks one yes/no per post with the search as shared state", async () => {
    vi.mocked(ask).mockResolvedValueOnce({ p0: { noul: 0.2 }, p1: { noul: 0.9 } });
    const scores = await relevance("parents pushing back on screens", [
      { id: "a", text: "tummy time" },
      { id: "b", text: "you told me I'm wrong about sweets" },
    ]);
    expect(vi.mocked(ask).mock.calls[0][0]).toEqual({ search: "parents pushing back on screens" });
    expect(scores).toEqual(new Map([["a", 0.2], ["b", 0.9]]));
  });

  it("orders the scored top by relevance and keeps the rest in word order", () => {
    const hits = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const out = applyRelevance(hits, new Map([["a", 0.1], ["b", 0.8], ["c", 0.8]]));
    expect(out.map((h) => h.id)).toEqual(["b", "c", "a", "d"]);
    expect(out[0].relevance).toBe(0.8);
    expect(out[3].relevance).toBeUndefined();
  });
});
