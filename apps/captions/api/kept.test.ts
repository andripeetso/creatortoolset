import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "kept-"));
process.env.DATA_DIR = dataDir;

const put = (rel: string, data: string) => {
  const p = path.join(dataDir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data);
};
const has = (rel: string) => existsSync(path.join(dataDir, rel));

put("assistant/images/tiny/a.png", "12345");
put("assistant/images/other/b.png", "123");
put("assistant/files/tiny/00000000-0000-4000-8000-0000000000aa/file", "1234567890");
put("assistant/files/tiny/00000000-0000-4000-8000-0000000000bb/parts/1", "12");
put("review/v1/meta.json", JSON.stringify({ owner: "tiny" }));
put("review/v2/meta.json", JSON.stringify({ owner: "other" }));
put("instagram/p1/meta.json", JSON.stringify({}));
put("workshop/sources/s1.json", JSON.stringify({ owner: "tiny" }));
put("workshop/sources/s1.txt", "text");

const { keptView, emptyKept } = await import("./kept");
const tiny = { username: "tiny", role: "user" } as Parameters<typeof keptView>[0];
const admin = { username: "boss", role: "admin" } as Parameters<typeof keptView>[0];
const row = async (u: typeof tiny, kind: string) => (await keptView(u)).rows.find((r) => r.kind === kind)!;

it("counts only the account's own files, and owner-less ones for an admin", async () => {
  expect(await row(tiny, "chat-pictures")).toMatchObject({ items: 1, bytes: 5 });
  expect(await row(tiny, "chat-videos")).toMatchObject({ items: 2, keepDays: 7 });
  expect(await row(tiny, "review")).toMatchObject({ items: 1 });
  expect(await row(tiny, "analyzer")).toMatchObject({ items: 0 });
  expect(await row(admin, "analyzer")).toMatchObject({ items: 1 });
  expect((await row(tiny, "workshop")).bytes).toBeGreaterThan(4);
});

it("Empty clears that account's kind only, and keeps a chat video still uploading", async () => {
  await emptyKept("chat-pictures", tiny);
  await emptyKept("chat-videos", tiny);
  expect(has("assistant/images/tiny/a.png")).toBe(false);
  expect(has("assistant/images/other/b.png")).toBe(true);
  expect(has("assistant/files/tiny/00000000-0000-4000-8000-0000000000aa")).toBe(false);
  expect(has("assistant/files/tiny/00000000-0000-4000-8000-0000000000bb/parts/1")).toBe(true);
});
