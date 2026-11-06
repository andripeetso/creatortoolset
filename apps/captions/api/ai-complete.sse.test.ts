import { describe, expect, it } from "vitest";
import { SseReader } from "./ai-complete";

describe("SseReader", () => {
  it("yields data payloads across chunk boundaries and joins multi-line data", () => {
    const r = new SseReader();
    expect(r.push('data: {"a":1}\n\nda')).toEqual(['{"a":1}']);
    expect(r.push('ta: {"b":\ndata: 2}\n\n: comment\n\ndata: [DONE]\n\n')).toEqual(['{"b":\n2}', "[DONE]"]);
    expect(r.push("event: ping\n\n")).toEqual([]);
  });
});
