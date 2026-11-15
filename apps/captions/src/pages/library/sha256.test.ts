import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256 } from "./sha256";

describe("SHA-256 a piece at a time", () => {
  it("matches node's hash at every block edge, however the bytes are cut", () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const data = Uint8Array.from({ length: size }, (_, i) => (i * 31 + size) % 256);
      const want = createHash("sha256").update(data).digest("hex");
      expect(new Sha256().update(data).digest()).toBe(want);
      const h = new Sha256();
      for (let at = 0, cut = 1; at < size; at += cut, cut = (cut * 7 + 3) % 97 || 1) h.update(data.subarray(at, at + cut));
      expect(h.digest(), `size ${size}`).toBe(want);
    }
  });
});
