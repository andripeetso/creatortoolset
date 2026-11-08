import { describe, expect, it } from "vitest";
import { parseMachine } from "./providers";

describe("parseMachine", () => {
  it("keeps what a computer reports and drops what doesn't fit", () => {
    expect(parseMachine({ os: "mac", host: " studio ", cpu: "Apple M2", cpus: 8.4, memGb: 16, load: 0.25, freeGb: 99, gpu: "" })).toEqual({
      os: "mac", host: "studio", cpu: "Apple M2", cpus: 8, memGb: 16, load: 0.25,
    });
    expect(parseMachine({ cpus: 0, memGb: 16 })).toBeUndefined();
    expect(parseMachine("nope")).toBeUndefined();
    expect(parseMachine(null)).toBeUndefined();
  });
});
