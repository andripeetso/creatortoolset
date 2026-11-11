import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLibraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { STEPS, NEXT } from "./worker";
import { claimableBy, claimStep, nextFor, registerDeviceKinds } from "./engine";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-engine-"));
let db: DatabaseSync;

beforeAll(() => {
  db = openLibraryDb(path.join(dir, "library.db"));
  registerDeviceKinds(["fake-kind"]);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("editor step registry", () => {
  it("the server's STEPS and NEXT come from the registry: core kinds have handlers, device kinds do not", () => {
    expect(Object.keys(STEPS).sort()).toEqual(["analyze", "broll", "cards", "draft", "file", "post", "preview", "script"]);
    expect(NEXT.analyze).toEqual(["script"]);
    expect(NEXT.draft).toEqual(["broll"]);
    expect(NEXT.broll).toEqual(["post"]);
    expect(NEXT.cards).toEqual(["post"]);
    // the cards come after the B-roll only for an edit whose style names an animation style: every other edit's chain is the table's
    for (const kind of Object.keys(NEXT)) expect(nextFor(kind, {}, NEXT)).toEqual(NEXT[kind]);
    for (const kind of Object.keys(NEXT)) expect(nextFor(kind, { style: { id: "s", name: "Plain", notes: "", pace: "tight" } }, NEXT)).toEqual(NEXT[kind]);
    expect(nextFor("broll", { style: { id: "s", name: "With cards", notes: "", pace: "tight", animation: "a" } }, NEXT)).toEqual(["cards"]);
    expect(nextFor("draft", { style: { id: "s", name: "With cards", notes: "", pace: "tight", animation: "a" } }, NEXT)).toEqual(["broll"]);
    expect(NEXT.post).toEqual(["preview"]);
    expect(NEXT.preview).toEqual(["file"]);
    expect(STEPS["fake-kind"]).toBeUndefined();
  });

  it("a device claims only the device kinds it declares; a core kind named by a device is ignored", () => {
    expect(claimableBy(["fake-kind", "analyze", "unregistered"])).toEqual(["fake-kind"]);
    expect(claimableBy(["analyze"])).toEqual([]);
  });

  it("the server never claims a device kind, but still claims unknown kinds so they fail visibly", () => {
    const vid = "ed_reg:v1";
    enqueueJob(db, "lib_1", vid, "fake-kind", "u1", false, "edit_jobs");
    enqueueJob(db, "lib_1", "ed_reg:v2", "broll", "u1", false, "edit_jobs");
    const server = claimStep(db, "server", 300, 1000, "edit_jobs");
    expect(server).toMatchObject({ kind: "broll" });
    expect(claimStep(db, "server", 300, 1000, "edit_jobs")).toBeNull();
    expect(db.prepare("SELECT state FROM edit_jobs WHERE kind = 'fake-kind'").get()).toEqual({ state: "queued" });
  });

  it("a device claims a queued kind only when it declares it, and a device that declares nothing claims nothing", () => {
    expect(claimStep(db, [], 300, 1000, "edit_jobs")).toBeNull();
    expect(claimStep(db, claimableBy(["analyze"]), 300, 1000, "edit_jobs")).toBeNull();
    const job = claimStep(db, claimableBy(["fake-kind"]), 300, 1000, "edit_jobs");
    expect(job).toMatchObject({ kind: "fake-kind", state: "running", attempts: 1 });
  });
});
