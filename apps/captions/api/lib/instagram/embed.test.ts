import { describe, expect, it } from "vitest";
import { cosine, hashEmbed, tokenize } from "./embed";

describe("hashEmbed", () => {
  it("ranks the same idea above an unrelated caption", () => {
    const q = hashEmbed("first 3 seconds talking head hook");
    const a = hashEmbed("talking head hook in the first 3 seconds of the reel");
    const b = hashEmbed("sunset beach vacation vlog with a drone");
    expect(cosine(q, a)).toBeGreaterThan(cosine(q, b));
  });

  it("tokenizes words", () => {
    expect(tokenize("Hello, WORLD!!")).toEqual(["hello", "world"]);
  });
});
