import { describe, expect, it } from "vitest";
import { weightFor } from "@contracts/devices";
import type { StorageView } from "@contracts/storage";
import { andList, readyLine, sharedFolders, skippedLine } from "./HelperStep";

const mac = { kinds: ["cards-draw", "helper-check"], report: { at: 0, drivers: [], homes: [], machine: { os: "mac" as const, cpus: 8, memGb: 16 } } };
const linux = { kinds: ["transcribe", "helper-check"], report: { at: 0, drivers: [], homes: [], machine: { os: "linux" as const, cpus: 32, memGb: 62 } } };
const passed = { at: 1, ffmpeg: true, encode: 5, folders: [{ id: "a", name: "Footage", ok: true }, { id: "b", name: "Music", ok: true }] };

describe("the Help screen", () => {
  it("says what the computer takes and from where, only once the test went well", () => {
    expect(readyLine(mac, passed)).toBe("Ready: this computer takes drafts and renders from Footage and Music");
    expect(readyLine(linux, { ...passed, folders: [] })).toBe("Ready: this computer takes transcripts");
    expect(readyLine(mac, { ...passed, folders: [{ id: "a", name: "Footage", ok: false, error: "x" }] })).toBeNull();
    expect(readyLine(mac, { ...passed, encode: undefined })).toBeNull();
    expect(andList(["A", "B", "C"])).toBe("A, B and C");
  });

  it("sets the weight from the result: Off when anything failed, else by encode speed", () => {
    expect(weightFor({ ffmpeg: true, encode: 5, folders: [] })).toBe(100);
    expect(weightFor({ ffmpeg: true, encode: 2, folders: [] })).toBe(50);
    expect(weightFor({ ffmpeg: true, encode: 1, folders: [] })).toBe(25);
    expect(weightFor({ ffmpeg: true, encode: 5, folders: [{ id: "a", ok: false }] })).toBe(0);
    expect(weightFor({ ffmpeg: false, folders: [] })).toBe(0);
  });

  it("lists the other computers' folders once each, and how a skipped one is worked on", () => {
    const f = (id: string, host: string, p: string, workspace?: string) => ({ id, role: "footage" as const, name: p, origin: { host, path: p }, make: false, createdAt: 0, reach: {}, ...(workspace ? { workspace } : {}) });
    const storage = { serverDisks: [], folders: [f("1", "studio", "/Volumes/T/A", "w1"), f("2", "studio", "/Volumes/T/A", "w2"), f("3", "me", "/Users/me/B")], copied: ["2"] } as StorageView;
    const listed = sharedFolders(storage, "me");
    expect(listed.map((x) => x.id)).toEqual(["1"]);
    expect(skippedLine(listed[0]!, storage.copied, "Tiny Studio Mac")).toBe("Stays on Tiny Studio Mac");
    expect(skippedLine(storage.folders[1]!, storage.copied, "Tiny Studio Mac")).toBe("Through the server copy");
  });
});
