import { describe, expect, it } from "vitest";
import { finalsItemName } from "./finals";

describe("finalsItemName", () => {
  it("drops the draft mark and keeps the version letter", () => {
    expect(finalsItemName("Talk_B_D2.mp4")).toBe("Talk_B.mp4");
    expect(finalsItemName("Talk_D3.mp4")).toBe("Talk.mp4");
    expect(finalsItemName("Talk_A_D12")).toBe("Talk_A");
  });
  it("leaves older names and names without a draft mark alone", () => {
    expect(finalsItemName("Talk_V2A_D1.mp4")).toBe("Talk_V2A_D1.mp4");
    expect(finalsItemName("Talk final.mov")).toBe("Talk final.mov");
    expect(finalsItemName("DRAFT_D")).toBe("DRAFT_D");
  });
});
