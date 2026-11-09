import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-refs-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { collectionApp } = await import("./collections");
const { externalLibraryRef } = await import("./attach");
const { addExternalItem, externalRefById, externalRefFor } = await import("./refs");
const { registerLibrarySlot, resetLibrarySlots } = await import("./sources");
const { parseTurnInput } = await import("../lib/workshop/validate");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/library", collectionApp);

const call = (user: string, method: string, url: string, body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(url, {
      method,
      headers: { "x-user": user, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

// A made-up plug-in source; its items are numbered like integer ids.
const SOURCE = "testsource";

/** The source as a plug-in registers it: the source itself, with no policy yet. */
const registerSource = () => registerLibrarySlot("test", { source: { id: SOURCE, label: "Test source" } });
/** The policy a plug-in adds later: every item but 9999 is visible to the owner. */
const registerPolicy = () =>
  registerLibrarySlot("test-policy", { policies: [{ sourceId: SOURCE, canSee: (_v, a) => a.external?.externalId !== "9999" }] });

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_r', 'owner-r', 'R', 'local', 0)").run();
  libraryDb().prepare("INSERT INTO pieces (id, library_id, label, created_by, created_at) VALUES ('pce_r', 'lib_r', 'Finals', 'owner-r', 1)").run();
});

beforeEach(() => registerSource());
afterEach(() => resetLibrarySlots());

const rowCount = (): number => (libraryDb().prepare("SELECT COUNT(*) AS n FROM external_refs").get() as { n: number }).n;
const piecesOf = async (user: string) => (await (await call(user, "GET", "/api/library/lib_r/pieces")).json() as { pieces: unknown }).pieces as { id: string; items: { externalRef: string | null }[] }[];

describe("external refs", () => {
  it("a source that is not registered gets no ref, and no row is written", () => {
    resetLibrarySlots();
    expect(externalRefFor(SOURCE, "clip", "1234")).toBeNull();
    expect(rowCount()).toBe(0);
  });

  it("a registered source gives each of its items one stable public id, and a non-empty title replaces the stored one", () => {
    const first = externalRefFor(SOURCE, "clip", "1234", "First title")!;
    expect(first.id).toMatch(/^ext_/);
    expect(first.externalId).toBe("1234");
    expect(externalRefFor(SOURCE, "clip", "1234")!.id).toBe(first.id);
    expect(externalRefFor(SOURCE, "clip", "1234", "New title")!.title).toBe("New title");
    expect(externalRefFor(SOURCE, "clip", "bad id with spaces")).toBeNull();
    expect(externalRefById(first.id)?.title).toBe("New title");
  });

  it("an item of a source with no policy is left out of the piece until a policy is registered, then the owner sees it", async () => {
    const ref = externalRefFor(SOURCE, "clip", "2001", "Reel one")!;
    expect(addExternalItem("pce_r", ref, "A")).toBe(true);
    expect(addExternalItem("pce_r", ref, "A")).toBe(false); // a piece holds an item once

    expect((await piecesOf("owner-r")).some((p) => p.items.length)).toBe(false);

    registerPolicy();
    const seen = (await piecesOf("owner-r")).find((p) => p.id === "pce_r")!;
    expect(seen.items.map((i) => i.externalRef)).toEqual([ref.id]);
  });

  it("the policy decides per item: a refused source id stays hidden, and a stranger gets 404 on the piece", async () => {
    registerPolicy();
    const hidden = externalRefFor(SOURCE, "clip", "9999", "Refused")!;
    addExternalItem("pce_r", hidden, "B");
    const seen = (await piecesOf("owner-r")).find((p) => p.id === "pce_r")!;
    expect(seen.items.map((i) => i.externalRef)).not.toContain(hidden.id);
    expect((await call("stranger", "GET", "/api/library/lib_r/pieces")).status).toBe(404);
  });

  it("an external ref has no file here: its id as a version answers 404 on the media route", async () => {
    const ref = externalRefFor(SOURCE, "clip", "2001")!;
    expect((await call("owner-r", "GET", `/api/library/media/${ref.id}/thumb`)).status).toBe(404);
  });

  it("a Workshop link with a source's id opens once the policy allows it, and a refused one does not", async () => {
    registerPolicy();
    const pick = { source: SOURCE, kind: "clip", externalId: "2001" };
    const kept = await externalLibraryRef("owner-r", pick);
    expect(kept).toEqual({ kind: "external", refId: externalRefFor(SOURCE, "clip", "2001")!.id, title: "Reel one" });
    expect(await externalLibraryRef("owner-r", { refId: kept!.refId })).toEqual(kept);
    expect(await externalLibraryRef("owner-r", { source: SOURCE, kind: "clip", externalId: "9999" })).toBeNull();
    expect(await externalLibraryRef("stranger", pick)).toBeNull();
  });

  it("a link to a source that is not registered opens nothing and writes nothing", async () => {
    const before = rowCount();
    expect(await externalLibraryRef("owner-r", { source: "nobody", kind: "clip", externalId: "1" })).toBeNull();
    expect(rowCount()).toBe(before);
  });

  it("a send names a source's clip by its source, kind and id (numbers included), or by a ref; a malformed pick is dropped", () => {
    const parsed = parseTurnInput({
      docId: "doc-abcdef",
      text: "hi",
      library: [{ source: SOURCE, kind: "clip", externalId: 1234 }, { refId: "ext_0123456789abcdef" }, { source: "", kind: "clip", externalId: "1" }],
    });
    expect(parsed.library).toEqual([{ source: SOURCE, kind: "clip", externalId: "1234" }, { refId: "ext_0123456789abcdef" }]);
  });
});
