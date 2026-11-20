import { describe, expect, it } from "vitest";
import { cleanTitle, titlePrompt } from "./chat-title";

describe("chat titles", () => {
  it("keeps the first line without quotes, labels or a full stop", () => {
    expect(cleanTitle('"Edit the apology video."\nBecause the project is open')).toBe("Edit the apology video");
    expect(cleanTitle("Title: Floor time reel")).toBe("Floor time reel");
    expect(cleanTitle("  New chat ")).toBe("");
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle("x".repeat(200))).toHaveLength(120);
  });

  it("gives the model what came with a vague message", () => {
    const p = titlePrompt({ text: "edit the video", project: "ApologyVideoButStandalone", page: "Content Workshop", attachments: ["clip.mov"] });
    expect(p).toContain("User message:\nedit the video");
    expect(p).toContain("Open project: ApologyVideoButStandalone");
    expect(p).toContain("Attachments: clip.mov");
    expect(p).not.toContain("Quoted");
  });
});
