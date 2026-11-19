import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "owned-projects-"));
const dir = path.join(process.env.DATA_DIR, "workshop", "projects");
mkdirSync(dir, { recursive: true });
const put = (id: string, owner: string, name = id) => writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, owner, name, updatedAt: Date.now() }));
const { ownedProjects } = await import("./workspace");
const names = async (who: string) => (await ownedProjects(who)).map((p) => p.name).sort();

it("reads only the account's own project files once their owners are known", async () => {
  put("p1", "ana");
  put("p2", "bob");
  expect(await names("ana")).toEqual(["p1"]);
  // bob's file is not opened again for ana: a project's owner never changes
  put("p2", "ana");
  expect(await names("ana")).toEqual(["p1"]);
  // her own file is read fresh: a save's new name shows at once
  put("p1", "ana", "Renamed");
  expect(await names("ana")).toEqual(["Renamed"]);
});

it("a project added or removed shows at once", async () => {
  put("p3", "ana");
  expect(await names("ana")).toEqual(["Renamed", "p3"]);
  rmSync(path.join(dir, "p3.json"));
  expect(await names("ana")).toEqual(["Renamed"]);
});
