import { describe, expect, it } from "vitest";
import { cleanTitle, sourceOf, titlePrompt } from "./chat-title";

describe("chat titles", () => {
  it("keeps the first line without quotes, labels or a full stop", () => {
    expect(cleanTitle('"Edit the apology video."\nBecause the project is open')).toBe("Edit the apology video");
    expect(cleanTitle("Title: Floor time reel")).toBe("Floor time reel");
    expect(cleanTitle("Here's a title:\n\nFloor time reel")).toBe("Floor time reel");
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

  it("rebuilds a saved chat's source from its first message and first finished answer", () => {
    const at = 0;
    const s = sourceOf([
      { id: "1", role: "user", text: "edit the video", at, files: [{ id: "f", name: "clip.mov" }], folders: ["Footage"], quote: "the end" },
      { id: "2", role: "assistant", text: "", at, status: "error" },
      { id: "3", role: "assistant", text: "Cut the apology video.", at, status: "done" },
    ]);
    expect(s).toEqual({ text: "edit the video", quote: "the end", attachments: ["clip.mov", "Footage"], reply: "Cut the apology video." });
    expect(titlePrompt(s!)).toContain("The assistant's first answer:\nCut the apology video.");
    expect(sourceOf([])).toBeNull();
  });
});
