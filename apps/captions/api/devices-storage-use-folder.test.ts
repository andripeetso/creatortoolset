import { mkdtempSync, rmSync } from "node:fs";
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
  expect(a).toMatchObject({ role: "projects", origin: { host: "dev-a", path: "/Volumes/Tiny Footage/Projects" } });
  expect(b).toMatchObject({ role: "projects", origin: { host: "dev-b", path: "/Volumes/Other Drive/Projects" } });
  expect((again as { id: string }).id).toBe((a as { id: string }).id);
});

it("a Media folder at a volume's root gets no Projects folder: the answer says what to choose", async () => {
  await changeStorage("ana", (st) => {
    st.folders.push({ ...media("dev-c", "/Volumes/MONOLITH"), id: "media-root" });
  });
  const r = await ensureUseFolder("ana", "ws-a", "projects", "dev-c");
  expect(r).toEqual({ error: "Choose a Projects folder in Settings → Folders." });
});
