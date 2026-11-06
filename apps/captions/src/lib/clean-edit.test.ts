import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EDIT } from "@contracts/clean-edit";
import { draftFetch, measureEdit, previewEditFrame } from "./clean-edit";
afterEach(() => vi.unstubAllGlobals());
describe("interactive draft requests", () => {
  it("never retries a busy preview or analysis, avoiding a retry backlog", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Busy" }), { status: 409 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      previewEditFrame("source", DEFAULT_EDIT, 0, new AbortController().signal),
    ).rejects.toThrow("Busy");
    await expect(
      measureEdit("source", DEFAULT_EDIT, new AbortController().signal),
    ).rejects.toThrow("Busy");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["score", "sscd"])(
    "cancels %s independently of full renders and frame previews",
    async (action) => {
      const fetcher = vi.fn(async (url: string, options: RequestInit) => {
        if (url.endsWith("/cancel")) return new Response(null, { status: 204 });
        await new Promise<void>((_resolve, reject) =>
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          ),
        );
        return new Response();
      });
      vi.stubGlobal("fetch", fetcher);
      const controller = new AbortController();
      const request = draftFetch(
        "source",
        action,
        DEFAULT_EDIT,
        controller.signal,
        (r) => r.json(),
      );
      controller.abort();
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher.mock.calls[1][0]).toBe(
        `/api/clean/sources/source/${action}/cancel`,
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it("explicitly cancels obsolete server work and uses a higher revision for the replacement", async () => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/cancel")) return new Response(null, { status: 204 });
      await new Promise<void>((_resolve, reject) =>
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        ),
      );
      return new Response();
    });
    vi.stubGlobal("fetch", fetcher);
    const old = new AbortController();
    const pending = previewEditFrame("source", DEFAULT_EDIT, 0, old.signal);
    old.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher.mock.calls[1][0]).toBe(
      "/api/clean/sources/source/draft/cancel",
    );
    expect(fetcher.mock.calls[1][1].headers).toEqual(
      fetcher.mock.calls[0][1].headers,
    );
    const next = new AbortController();
    const latest = measureEdit("source", DEFAULT_EDIT, next.signal);
    const previousHeaders = fetcher.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    const latestHeaders = fetcher.mock.calls[2][1].headers as Record<
      string,
      string
    >;
    expect(Number(latestHeaders["X-Clean-Revision"])).toBeGreaterThan(
      Number(previousHeaders["X-Clean-Revision"]),
    );
    next.abort();
    await expect(latest).rejects.toMatchObject({ name: "AbortError" });
  });
});
