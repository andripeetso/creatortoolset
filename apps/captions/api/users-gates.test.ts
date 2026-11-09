import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// users.json is read once at import (users.ts load()), so the file is written before the module loads.
const dir = mkdtempSync(path.join(tmpdir(), "users-gates-"));
process.env.DATA_DIR = dir;
writeFileSync(
  path.join(dir, "users.json"),
  JSON.stringify({
    users: [
      {
        username: "ana",
        role: "user",
        // a gate of a plug-in that is not loaded here, a retired app id, a built-in app, and junk that load() must drop
        off: ["tiny-footage", "finals", "media", "Bad Id", 42],
        usage: {},
        createdAt: 1,
      },
    ],
  }),
);

const { findUser, setOff } = await import("./users");
const { RETIRED_APP_IDS, isPluginGateId } = await import("../contracts/tools");

describe("users.json off list", () => {
  it("keeps the off entries of gates and retired app ids that are not loaded, and drops junk", () => {
    expect(findUser("ana")?.off).toEqual(["tiny-footage", "finals", "media"]);
  });

  it("keeps a retired app id when the off list is saved again", () => {
    const ana = findUser("ana");
    if (!ana) throw new Error("ana missing");
    setOff(ana, ["finals", "tiny-footage"]);
    expect(findUser("ana")?.off).toEqual(["finals", "tiny-footage"]);
  });
});

describe("retired app ids are never plug-in gates", () => {
  it("refuses every retired id as a gate", () => {
    expect(RETIRED_APP_IDS.length).toBeGreaterThan(0);
    for (const id of RETIRED_APP_IDS) expect(isPluginGateId(id), id).toBe(false);
  });
});
