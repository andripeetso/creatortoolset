import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiRequestError,
  cancelCadenceRequest,
  estimateCadenceDuration,
  isOutOfTokensError,
  OUT_OF_TOKENS_CODE,
  refineSegments,
  refineSplits,
} from "./refine";

afterEach(() => vi.unstubAllGlobals());

describe("estimateCadenceDuration", () => {
  it("uses the measured short-video cohort", () => {
    expect(estimateCadenceDuration(182)).toMatchObject({
      expectedSeconds: 40,
      lowSeconds: 30,
      highSeconds: 50,
    });
  });

  it("uses the measured long-video median and its wider tail", () => {
    expect(estimateCadenceDuration(541)).toMatchObject({
      expectedSeconds: 35,
      lowSeconds: 25,
      highSeconds: 90,
    });
  });

  it("accounts for parallel chunking instead of scaling linearly", () => {
    const oneFullChunk = estimateCadenceDuration(500);
    const splitTranscript = estimateCadenceDuration(541);
    expect(splitTranscript.expectedSeconds).toBeLessThan(oneFullChunk.expectedSeconds);
    expect(splitTranscript.highSeconds).toBeGreaterThan(splitTranscript.expectedSeconds * 2);
  });

  it("keeps the user-facing range inside the server timeout", () => {
    const estimate = estimateCadenceDuration(20_000);
    expect(estimate.expectedSeconds).toBeLessThanOrEqual(150);
    expect(estimate.highSeconds).toBeLessThanOrEqual(240);
  });
});

describe("cadence request control", () => {
  it.each([{}, { breaks: [0] }, { marks: [] }, { marks: [2, 0] }, { marks: [3] }, { marks: ["2"] }])(
    "rejects malformed cadence output instead of reporting a match: %j",
    async (payload) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => payload,
      }));
      await expect(refineSegments(
        [{ id: 1, text: "Hello", start: 0, end: 0.4 }]
      )).rejects.toThrow("invalid grouping");
    }
  );

  it("sends the cancellation id and abort signal with a cadence request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ marks: [2] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const marks = await refineSegments(
      [{ id: 1, text: "Hello", start: 0, end: 0.4 }],
      { signal: controller.signal, requestId: "cadence-test-1" }
    );

    expect(marks).toEqual([2]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ requestId: "cadence-test-1" });
    // the marks don't depend on the box, so its size isn't sent
    expect(body).not.toHaveProperty("maxChars");
  });

  it("sends a best-effort server cancellation request", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    cancelCadenceRequest("cadence-test-2");
    expect(fetchMock).toHaveBeenCalledWith("/api/ai/segment/cadence-test-2", {
      method: "DELETE",
      keepalive: true,
    });
  });

  it("preserves an out-of-tokens error code from the server", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        error:
          "The AI caption pass is out of credits, so it can't run. Tell the admin so they can top it up.",
        code: OUT_OF_TOKENS_CODE,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = await refineSegments([
      { id: 1, text: "Hello", start: 0, end: 0.4 },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRequestError);
    expect(isOutOfTokensError(err)).toBe(true);
  });

  it.each([{}, { splits: [] }, { splits: [[0]] }, { splits: [[5]] }, { splits: [["1"]] }])(
    "rejects malformed line splits: %j",
    async (payload) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
      await expect(refineSplits([["is", "one", "of", "our"]], 26)).rejects.toThrow("invalid line splits");
    },
  );

  it("sends only the long lines and the box width", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ splits: [[2]] }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await refineSplits([["is", "one", "of", "our"]], 26)).toEqual([[2]]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/split");
    expect(JSON.parse(init.body)).toEqual({ lines: [["is", "one", "of", "our"]], maxChars: 26 });
  });
});
