import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "work-prefs-"));
const { readWorkPrefs, writeWorkPrefs } = await import("./work-prefs");

describe("what she wants to do first (job)", () => {
  it("is saved when it is one of the jobs, and null clears it", () => {
    expect(writeWorkPrefs("tiny", { job: "edit" })).toMatchObject({ job: "edit" });
    expect(readWorkPrefs("tiny").job).toBe("edit");
    expect(writeWorkPrefs("tiny", { makes: ["reel"] })).toMatchObject({ job: "edit", makes: ["reel"] }); // kept when not given
    expect(writeWorkPrefs("tiny", { job: null })).toMatchObject({ job: null });
  });

  it("refuses anything else and keeps what was there", () => {
    writeWorkPrefs("tiny", { job: "write" });
    expect(writeWorkPrefs("tiny", { job: "clean" })).toMatch(/^job is one of/);
    expect(writeWorkPrefs("tiny", { job: 3 })).toMatch(/^job is one of/);
    expect(readWorkPrefs("tiny").job).toBe("write");
  });

  it("reads as null on a record saved before the field existed", () => {
    mkdirSync(path.join(process.env.DATA_DIR!, "work-prefs"), { recursive: true });
    writeFileSync(path.join(process.env.DATA_DIR!, "work-prefs", "older.json"), JSON.stringify({ talk: "both", check: "app", editor: null, makes: [] }));
    expect(readWorkPrefs("older")).toMatchObject({ talk: "both", job: null });
  });
});

describe("the editor's keys (keyPreset, keys)", () => {
  it("are kept per account and read back, the other fields left as they were", () => {
    writeWorkPrefs("tiny", { talk: "both" });
    expect(writeWorkPrefs("tiny", { keyPreset: "resolve", keys: { X: "cut", W: "" } })).toMatchObject({ talk: "both", keyPreset: "resolve" });
    expect(readWorkPrefs("tiny")).toMatchObject({ keyPreset: "resolve", keys: { X: "cut", W: "" } });
    expect(readWorkPrefs("someone-else").keys).toBeUndefined();
  });

  it("refuses an unknown preset and keys that are not chord → command id", () => {
    expect(writeWorkPrefs("tiny", { keyPreset: "premiere" })).toMatch(/^keyPreset is one of/);
    expect(writeWorkPrefs("tiny", { keys: ["X"] })).toBe("keys is chord → command id");
    expect(writeWorkPrefs("tiny", { keys: { X: 3 } })).toBe("keys is chord → command id");
    expect(writeWorkPrefs("tiny", { keys: { X: "<script>" } })).toBe("keys is chord → command id");
    expect(readWorkPrefs("tiny").keys).toEqual({ X: "cut", W: "" });
  });
});
