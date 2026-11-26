import { describe, expect, it } from "vitest";
import { ownFailure } from "./boot";

describe("ownFailure", () => {
  it("sends the app's own 502 and 504 as 500, which a proxy passes on with the message", () => {
    expect([502, 504].map(ownFailure)).toEqual([500, 500]);
    expect([200, 402, 500, 503].map(ownFailure)).toEqual([200, 402, 500, 503]);
  });
});
