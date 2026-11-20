// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { addAutosave, fingerprint, markSaved, readAutosaves, setAutosaveStore, toRestore, type AutosaveStore, type Ring } from "./autosave";
import type { NleTimeline } from "./model";

const tl = (rec: number) => ({ timeline: { fps: 25 }, sources: {}, tracks: { V1: { items: [{ src: "a", rec, len: 10, in: 0 }] } } }) as unknown as NleTimeline;

/** a store in memory, as IndexedDB would keep it across a reload */
const memStore = (disk = new Map<string, Ring>()): AutosaveStore & { disk: Map<string, Ring> } => ({
  disk,
  get: async (k) => structuredClone(disk.get(k)),
  put: async (k, r) => void disk.set(k, structuredClone(r)),
});

beforeEach(() => localStorage.clear());

describe("autosaves", () => {
  it("keep the last 20 per timeline, the oldest going first, and are there after a reload", async () => {
    const s = memStore();
    setAutosaveStore(s);
    for (let i = 0; i < 25; i++) await addAutosave("tiny/D2", { at: i + 1, base: "b", tl: tl(i) });
    await addAutosave("tiny/D3", { at: 1, base: "b", tl: tl(0) });
    const r = await readAutosaves("tiny/D2");
    expect(r.list.map((a) => a.at)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
    setAutosaveStore(memStore(s.disk)); // a reload
    expect((await readAutosaves("tiny/D2")).list).toHaveLength(20);
    expect((await readAutosaves("tiny/D3")).list).toHaveLength(1);
  });

  it("a reopen gets the newest made on that same timeline, and none from before the last save", async () => {
    setAutosaveStore(memStore());
    const base = fingerprint(tl(0));
    await addAutosave("tiny/D2", { at: 10, base, tl: tl(1) });
    await addAutosave("tiny/D2", { at: 20, base, tl: tl(2) });
    await addAutosave("tiny/D2", { at: 30, base: fingerprint(tl(9)), tl: tl(3) });
    expect(toRestore(await readAutosaves("tiny/D2"), base)?.tl).toEqual(tl(2));
    expect(toRestore(await readAutosaves("tiny/D2"), fingerprint(tl(5)))).toBeNull();
    const r = await markSaved("tiny/D2", 25);
    expect(toRestore(r, base)).toBeNull();
    expect(r.list).toHaveLength(3); // a save keeps them, to restore by hand
    expect(toRestore(await addAutosave("tiny/D2", { at: 40, base, tl: tl(4) }), base)?.tl).toEqual(tl(4));
  });

  it("move the copy kept in localStorage before them into the ring once, and remove it", async () => {
    const s = memStore();
    setAutosaveStore(s);
    const base = fingerprint(tl(0));
    localStorage.setItem("ct-nle-unsaved:tiny/D2", JSON.stringify({ base, tl: tl(5) }));
    const r = await readAutosaves("tiny/D2");
    expect(toRestore(r, base)?.tl).toEqual(tl(5));
    expect(localStorage.getItem("ct-nle-unsaved:tiny/D2")).toBeNull();
    expect(s.disk.get("tiny/D2")?.list).toHaveLength(1);
  });

  it("with storage refused, editing goes on: this session's only, and the old copy stays where it was", async () => {
    const no = () => { throw new Error("QuotaExceededError"); };
    setAutosaveStore({ get: no, put: no });
    localStorage.setItem("ct-nle-unsaved:tiny/D2", JSON.stringify({ base: "b", tl: tl(5) }));
    expect((await readAutosaves("tiny/D2")).list).toHaveLength(1);
    expect(localStorage.getItem("ct-nle-unsaved:tiny/D2")).not.toBeNull();
    expect((await addAutosave("tiny/D2", { at: Date.now() + 1, base: "b", tl: tl(6) })).list).toHaveLength(2);
    setAutosaveStore({ get: () => Promise.reject(new Error("blocked")), put: () => Promise.reject(new Error("blocked")) });
    expect((await addAutosave("tiny/D4", { at: 1, base: "b", tl: tl(6) })).list).toHaveLength(1);
    // this test browser has no IndexedDB at all: the real store says nothing and keeps nothing
    setAutosaveStore();
    expect((await addAutosave("tiny/D5", { at: 1, base: "b", tl: tl(6) })).list).toHaveLength(1);
  });
});
