import { afterEach, describe, expect, it, vi } from "vitest";
import { localThumb } from "./local-thumbs";

const inMacApp = (mark: string) => vi.stubGlobal("document", { documentElement: { dataset: { macLocalThumbs: mark } } });
afterEach(() => vi.unstubAllGlobals());

describe("localThumb", () => {
  it("turns a thumb or sprite of the server into the Mac app's address, the query kept", () => {
    inMacApp("1");
    const url = "/api/library/media/abc-123_x/thumb?t=7&v=4096";
    const out = localThumb(url)!;
    expect(out.startsWith("ctlocal://thumb/")).toBe(true);
    const b64 = out.slice("ctlocal://thumb/".length);
    expect(b64).not.toMatch(/[+/=]/);
    expect(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).toBe(url);
    expect(localThumb("/api/library/media/v1/sprite")).toMatch(/^ctlocal:\/\/thumb\//);
  });

  it("returns the URL unchanged outside the Mac app, in an older one, or for nothing", () => {
    expect(localThumb("/api/library/media/v1/thumb")).toBe("/api/library/media/v1/thumb");
    inMacApp("0");
    expect(localThumb("/api/library/media/v1/thumb")).toBe("/api/library/media/v1/thumb");
    expect(localThumb(undefined)).toBeUndefined();
  });

  it("turns a Review thumb from mark 2 on only", () => {
    const url = "/api/review/assets/3f2a-b_c/v/12/thumb?c=1763840000000";
    inMacApp("1");
    expect(localThumb(url)).toBe(url);
    inMacApp("2");
    expect(localThumb(url)).toMatch(/^ctlocal:\/\/thumb\//);
    expect(localThumb("/api/library/media/v1/thumb")).toMatch(/^ctlocal:\/\/thumb\//);
    for (const other of ["/api/review/assets/a1/v/1/play?c=1", "/api/review/trash/a1/thumb", "/api/review/s/tok/v/1/thumb?c=1"]) expect(localThumb(other)).toBe(other);
  });

  it("leaves every other path as it is, even in the Mac app", () => {
    inMacApp("1");
    for (const url of [
      "/api/library/media/ext_abc/thumb",
      "/api/library/media/v1/play",
      "/api/library/media/v1/source",
      "/api/library/media/v1/thumb/../../x",
      "https://example.com/api/library/media/v1/thumb",
      "/api/library/media/v1/thumb?x=<script>",
      "ctlocal://media/AAAA",
    ]) {
      expect(localThumb(url)).toBe(url);
    }
  });
});
