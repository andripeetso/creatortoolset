// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

// A drop's card takes the file's shape as soon as its metadata is read, while the file still waits to go in.
vi.mock("@/lib/onMac", () => ({ quickPrint: async () => "q", shapeOf: async (f: File) => (f.name.includes("wide") ? 16 / 9 : 9 / 16) }));
vi.mock("@/lib/library", () => ({
  audioOf: () => ({}),
  checkUpload: () => new Promise(() => {}),
  getEstimate: async () => ({ steps: [] }),
  uploadFile: () => new Promise(() => {}),
}));
vi.mock("@/pages/library/Uploads", () => ({ alreadyThere: () => new Promise(() => {}) }));

const { addImports, resetImportQueue, useImportQueue } = await import("./import-queue");

afterEach(() => resetImportQueue());

describe("a drop's file shape", () => {
  it("is on its queue item once read, before the file is sent", async () => {
    addImports([new File(["x"], "Tiny wide.mp4", { type: "video/mp4" }), new File(["x"], "Tiny tall.mov", { type: "video/quicktime" })], { libraryId: "lib_1", mac: false, cost: false });
    await vi.waitFor(() => expect(useImportQueue.getState().items.map((u) => u.aspect)).toEqual([16 / 9, 9 / 16]));
    expect(useImportQueue.getState().items.every((u) => u.status === "waiting" || u.status === "checking")).toBe(true);
  });
});
