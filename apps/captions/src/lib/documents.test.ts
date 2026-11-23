import { afterEach, expect, it, vi } from "vitest";
import { okId } from "../../api/lib/ids";
import { newDocumentId } from "./documents";

afterEach(() => vi.unstubAllGlobals());

it("makes a new document's id on a plain http:// address too, one the server takes", () => {
  // a page not on HTTPS or localhost: no randomUUID, getRandomValues still there
  const real = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
  const id = newDocumentId();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(okId(id)).toBe(true);
  expect(newDocumentId()).not.toBe(id);
});
