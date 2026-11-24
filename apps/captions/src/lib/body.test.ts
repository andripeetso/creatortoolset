import { describe, expect, it } from "vitest";
import { bodyOf } from "./body";

// a reply whose connection drops after its first bytes: headers said 200, the body never finishes
const cutOff = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"items":[{"id":'));
        c.error(new TypeError("Load failed"));
      },
    }),
    { status: 200 },
  );

describe("bodyOf", () => {
  it("rejects a body cut off on the way, never reads it as an empty answer", async () => {
    await expect(bodyOf(cutOff())).rejects.toThrow("Load failed");
  });

  it("rejects a successful answer that is not JSON", async () => {
    await expect(bodyOf(new Response("<html>", { status: 200 }))).rejects.toThrow();
  });

  it("reads JSON, an empty body as {}, and an error page as {} so the caller says the status", async () => {
    expect(await bodyOf(new Response('{"items":[]}'))).toEqual({ items: [] });
    expect(await bodyOf(new Response(null, { status: 200 }))).toEqual({});
    expect(await bodyOf(new Response("<html>Bad gateway</html>", { status: 502 }))).toEqual({});
    expect(await bodyOf(new Response('{"error":"Not found"}', { status: 404 }))).toEqual({ error: "Not found" });
  });
});
