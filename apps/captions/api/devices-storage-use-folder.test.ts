import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

// ensureUseFolder: one Projects folder per computer in a workspace, next to that computer's Media folder; never at a
// volume's root (its parent would be /Volumes, the system disk's).
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "use-folder-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { changeStorage, ensureUseFolder } = await import("./devices-storage");

const media = (host: string, p: string) => ({ id: `media-${host}`, role: "footage" as const, name: "Shoots", origin: { host, path: p }, make: false, createdAt: 0, reach: {}, workspace: "ws-a" });

it("a Projects folder is made per computer: the same computer gets its one, another computer gets its own", async () => {
  await changeStorage("ana", (st) => {
    st.folders.push(media("dev-a", "/Volumes/Tiny Footage/Shoots"), media("dev-b", "/Volumes/Other Drive/Shoots"));
  });
  const a = await ensureUseFolder("ana", "ws-a", "projects", "dev-a");
  const b = await ensureUseFolder("ana", "ws-a", "projects", "dev-b");
  const again = await ensureUseFolder("ana", "ws-a", "projects", "dev-a");
  expect(a).toMatchObject({ role: "projects", origin: { host: "dev-a", path: "/Volumes/Tiny Footage/Project files" } });
  expect(b).toMatchObject({ role: "projects", origin: { host: "dev-b", path: "/Volumes/Other Drive/Project files" } });
  expect((again as { id: string }).id).toBe((a as { id: string }).id);
});

it("a Media folder at a volume's root gets no Projects folder: the answer says what to choose", async () => {
  await changeStorage("ana", (st) => {
    st.folders.push({ ...media("dev-c", "/Volumes/MONOLITH"), id: "media-root" });
  });
  // "dev-c" is no computer anyone paired: the card says it can't find it, never that a folder is missing
  const r = await ensureUseFolder("ana", "ws-a", "projects", "dev-c");
  expect(r).toMatchObject({ wait: { missing: "computer", device: null, line: "Can't find dev-c right now: open Creator Toolset on it", actions: [{ id: "retry" }] } });
});

it("with no workspace named and two of the account's, no Projects folder is picked: the answer says what to choose", async () => {
  mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
  for (const id of ["ws-a", "ws-b"]) writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, updatedAt: 1 }));
  await changeStorage("ana", (st) => {
    st.folders.push({ ...media("dev-e", "/Volumes/Tiny Footage/Shoots"), id: "media-e-a" }, { ...media("dev-e", "/Volumes/Tiny Footage/Brand B/Shoots"), id: "media-e-b", workspace: "ws-b" });
  });
  expect(await ensureUseFolder("ana", undefined, "projects", "dev-e")).toEqual({ error: "Choose a Project files folder in Settings → Media Library." });
  // once the workspace is named, its own computer's folder beside its own Media folder
  expect(await ensureUseFolder("ana", "ws-b", "projects", "dev-e")).toMatchObject({ role: "projects", workspace: "ws-b", origin: { host: "dev-e", path: "/Volumes/Tiny Footage/Brand B/Project files" } });
});

it("with no workspace named, a single owned workspace is the job's; with two and no name, no other workspace's folder is picked", async () => {
  mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
  writeFileSync(path.join(dir, "workshop", "projects", "ws-solo.json"), JSON.stringify({ id: "ws-solo", owner: "eve", name: "solo", updatedAt: 1 }));
  await changeStorage("eve", (st) => {
    st.folders.push({ ...media("dev-g", "/Volumes/Tiny Footage/Shoots"), id: "media-g", workspace: "ws-solo" });
  });
  expect(await ensureUseFolder("eve", undefined, "projects", "dev-g")).toMatchObject({ role: "projects", workspace: "ws-solo", origin: { host: "dev-g", path: "/Volumes/Tiny Footage/Project files" } });
  // a second owned workspace makes the name required, and the first one's folder is not handed to a job without one
  writeFileSync(path.join(dir, "workshop", "projects", "ws-other.json"), JSON.stringify({ id: "ws-other", owner: "eve", name: "other", updatedAt: 1 }));
  expect(await ensureUseFolder("eve", undefined, "projects", "dev-g")).toEqual({ error: "Choose a Project files folder in Settings → Media Library." });
});
