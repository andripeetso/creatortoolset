import { afterEach, expect, it, vi } from "vitest";
import { chunkedUpload } from "./uploads";

// Stop on a chat reply that waits for its videos aborts their uploads: no part is sent after the abort.
afterEach(() => vi.unstubAllGlobals());

it("sends no further part once its signal is aborted, and rejects", async () => {
  const sent: string[] = [];
  const ctl = new AbortController();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "f1", partSize: 1 }), { status: 200 }));
  class FakeXhr {
    status = 200;
    response = {};
    upload: { onprogress?: unknown } = {};
    onload?: () => void;
    private url = "";
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send() {
      sent.push(this.url);
      ctl.abort(); // Stop pressed while the first parts are on their way
      this.onload?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  const file = new Blob([new Uint8Array(40)]);
  await expect(chunkedUpload("/api/assistant/files", "/api/assistant/files", file, { name: "a.mp4" }, () => {}, undefined, ctl.signal)).rejects.toThrow();
  // the six parallel senders each had one part on its way at most; the other 34 parts never went
  expect(sent.length).toBeLessThanOrEqual(6);
});
