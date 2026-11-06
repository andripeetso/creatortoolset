import { afterEach, describe, expect, it, vi } from "vitest";
import { addClipBlock, clipBlockLabels, retryClipBlock, type ClipSession } from "./clips";

afterEach(() => vi.unstubAllGlobals());

const clip = (over: Partial<ClipSession> = {}): ClipSession => ({
  id: "clip-1",
  name: "Review",
  duration: 1025,
  bytes: 1,
  mime: "video/quicktime",
  status: "ready",
  progress: 1,
  createdAt: 1,
  updatedAt: 1,
  hasTranscript: true,
  hasThumb: true,
  ...over,
});

function jsonResp(status: number, data: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

describe("addClipBlock", () => {
  it("returns a 200 payload from older servers without polling", async () => {
    const done = clip({
      blocks: [{ id: "actions", kind: "actions", items: [{ text: "Ship it" }] }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResp(200, done)),
    );
    await expect(addClipBlock("clip-1", "actions")).resolves.toEqual(done);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("polls until a 202 job finishes", async () => {
    const pending = clip({ generating: ["actions"] });
    const done = clip({
      blocks: [{ id: "actions", kind: "actions", items: [{ text: "Ship it" }] }],
    });
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith("/blocks")) return jsonResp(202, pending);
      return jsonResp(200, done);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(addClipBlock("clip-1", "actions")).resolves.toEqual(done);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a background AI error after polling", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith("/blocks")) {
        return jsonResp(202, clip({ generating: ["actions"] }));
      }
      return jsonResp(
        200,
        clip({ blockErrors: { actions: "Kimi API 502: overloaded" } }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(addClipBlock("clip-1", "actions")).rejects.toThrow(
      "Kimi API 502: overloaded",
    );
  });
});

describe("retryClipBlock", () => {
  it("waits out an in-flight generate instead of failing", async () => {
    const done = clip({
      blocks: [{ id: "actions", kind: "actions", items: [{ text: "Retry" }] }],
    });
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes("/retry")) {
        return jsonResp(409, { error: "Already generating" });
      }
      return jsonResp(200, done);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(retryClipBlock("clip-1", "actions")).resolves.toEqual(done);
  });
});

describe("clipBlockLabels", () => {
  it("lists generated sections for a document caption", () => {
    expect(
      clipBlockLabels(
        clip({
          summary: "Recap",
          blocks: [
            { id: "takeaways", kind: "takeaways", items: [{ text: "One" }] },
            { id: "actions", kind: "actions", items: [{ text: "Do it" }] },
          ],
          chapters: [{ t: 0, title: "Start" }],
        }),
      ),
    ).toEqual(["Takeaways", "Action plan", "Chapters"]);
  });
});
