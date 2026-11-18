import { describe, expect, it } from "vitest";
import { EVERY_WORKSPACE, type StorageFolder } from "../../contracts/storage";
import { finalsAsExports } from "./storage";

const f = (id: string, role: StorageFolder["role"], workspace?: string): StorageFolder =>
  ({ id, role, name: id, origin: { host: "mac", path: `/Volumes/T/${id}` }, make: false, createdAt: 0, reach: {}, ...(workspace ? { workspace } : {}) }) as StorageFolder;

describe("a legacy Finals folder (the Finals use is gone)", () => {
  it("becomes the workspace's Exports folder when it has none", () => {
    expect(finalsAsExports([f("fin", "finals", "ws-a")]).map((x) => x.role)).toEqual(["library"]);
  });

  it("becomes Media when its workspace already has an Exports folder, and is never dropped", () => {
    const out = finalsAsExports([f("lib", "library", "ws-a"), f("fin", "finals", "ws-a"), f("other", "finals", "ws-b")]);
    expect(out.map((x) => [x.id, x.role])).toEqual([["lib", "library"], ["fin", "footage"], ["other", "library"]]);
  });

  it("an every-workspace Exports folder counts for a workspace's Finals", () => {
    expect(finalsAsExports([f("lib", "library", EVERY_WORKSPACE), f("fin", "finals", "ws-a")]).map((x) => x.role)).toEqual(["library", "footage"]);
  });

  it("leaves every other folder as it is", () => {
    const media = f("m", "footage", "ws-a");
    expect(finalsAsExports([media])[0]).toBe(media);
  });
});
