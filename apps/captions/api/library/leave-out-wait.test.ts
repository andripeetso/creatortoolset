import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A clip matched to a file in a left-out folder waits for every Media folder of its computer to be read before it is
// trashed or kept, from when it was first found, through a second listing of its own folder and through a restart. While
// it waits with no known place outside a left-out folder it is hidden: out of the list, search, player and share links.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "leave-out-wait-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { createUser } = await import("../users");
const { applyReport, forgetOnRestart, indexForDevice, librariesOf, MOVED_IN } = await import("./report");
const { searchApp } = await import("./search");
const { libraryDb } = await import("./db");
const { buildAssetQuery, indexAsset } = await import("./query");
const { searchLibrary } = await import("./search");
const { libraryApp } = await import("./routes");
const { shareApp, publicShareApp } = await import("./shares");
const { changeStorage } = await import("../devices-storage");
const { deviceOf, pairDevice, revokeDevice, touchDevice } = await import("../lib/devices");
const { libraryStatus } = await import("./estimate");
const { setTrashedAt } = await import("./trash");
const DAY = 86_400_000;
createUser("tia", "password1", { role: "admin" });

const d = libraryDb();
const quick = (n: number) => n.toString(16).padStart(64, "0");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const onMac = (root: string, rel: string, q: number) => ({ name: path.basename(rel), path: `${root}/${rel}`, size: 10, quick: quick(q), frames: [], thumb: JPEG });
type File = { rel: string; q: number };
let n = 0;
let t = Date.now();

/** A computer with Media folders A (leaves out Private), B and C. */
function computer(name: string) {
  const mac = pairDevice("tia", name).device;
  const root = `/Volumes/${name}`;
  const ids = { A: `${name}-a`, B: `${name}-b`, C: `${name}-c` };
  const roots = { A: `${root}/A`, B: `${root}/B`, C: `${root}/C` };
  const list = (at: keyof typeof ids, files: File[]) =>
    applyReport(mac, [{ id: ids[at], state: "ok", scan: `s${++n}`, complete: true, files: files.map((f) => ({ path: `${roots[at]}/${f.rel}`, bytes: 10, mtime: 1, quick: quick(f.q) })), unreadable: [] }], (t += 1000));
  const away = (at: keyof typeof ids) => applyReport(mac, [{ id: ids[at], state: "disk_away", files: [], unreadable: [] }], (t += 1000));
  const page = (at: keyof typeof ids, scan: string, complete: boolean, files: File[]) =>
    applyReport(mac, [{ id: ids[at], state: "ok", scan, complete, files: files.map((f) => ({ path: `${roots[at]}/${f.rel}`, bytes: 10, mtime: 1, quick: quick(f.q) })), unreadable: [] }], (t += 1000));
  const index = async (at: keyof typeof ids, rel: string, q: number) =>
    ((await indexForDevice(mac, ids[at], onMac(roots[at], rel, q))) as { versions: { library: string; versionId: string }[] }).versions[0]!;
  const setUp = () =>
    changeStorage("tia", (st) => {
      for (const k of ["A", "B", "C"] as const)
        st.folders.push({ id: ids[k], role: "footage", name: k, origin: { host: mac.id, path: roots[k] }, make: false, createdAt: 0, reach: {}, ...(k === "A" ? { leaveOut: ["Private"] } : {}) });
    });
  return { mac, ids, roots, list, page, away, index, setUp };
}
const clip = (q: number) =>
  d.prepare("SELECT a.id, a.library_id, a.trashed_at, a.left_hidden_at, v.id AS version FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.quick = ?").get(quick(q)) as {
    id: string; library_id: string; trashed_at: number | null; left_hidden_at: number | null; version: string;
  };
const trashed = (q: number) => clip(q).trashed_at !== null;
const hidden = (q: number) => clip(q).left_hidden_at !== null;

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "tia", role: "admin" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/library", searchApp);
app.route("/api/library", shareApp);
app.route("/api/library", publicShareApp);

describe("probe A: a move into a folder whose drive is away", () => {
  const m = computer("Tiny Mac A");
  beforeAll(() => m.setUp());

  it("waits through a second listing of its own folder and a restart, and is kept and found once that drive is back", async () => {
    await m.index("A", "Day/x.mov", 700);
    await m.list("A", [{ rel: "Day/x.mov", q: 700 }]);
    await m.away("B");
    await m.list("A", [{ rel: "Private/x.mov", q: 700 }]);
    expect(trashed(700)).toBe(false);
    await m.away("B");
    await m.list("A", [{ rel: "Private/x.mov", q: 700 }]);
    expect(trashed(700)).toBe(false);
    forgetOnRestart(); // a restart
    await m.list("A", [{ rel: "Private/x.mov", q: 700 }]);
    expect(trashed(700)).toBe(false);
    await m.list("C", []);
    await m.list("B", [{ rel: "x.mov", q: 700 }]);
    expect(trashed(700)).toBe(false);
    expect(d.prepare("SELECT folder_id, state FROM version_places WHERE version_id = ? AND state IN ('verified','found')").all(clip(700).version)).toEqual([{ folder_id: "Tiny Mac A-b", state: "verified" }]);
  });
});

describe("probe B: a move between two other Media folders, listed B, A, C", () => {
  const m = computer("Tiny Mac B");
  beforeAll(() => m.setUp());

  it("is never trashed when the file turns up in C, and is trashed when it is gone from all three once all have listed", async () => {
    await m.index("B", "x.mov", 710);
    await m.index("B", "y.mov", 711);
    await m.list("B", []);
    await m.list("A", [{ rel: "Private/x.mov", q: 710 }, { rel: "Private/y.mov", q: 711 }]);
    expect([trashed(710), trashed(711)]).toEqual([false, false]);
    await m.list("C", [{ rel: "x.mov", q: 710 }]);
    expect([trashed(710), trashed(711)]).toEqual([false, false]);
    await m.list("B", []);
    expect([trashed(710), trashed(711)]).toEqual([false, true]);
  });
});

describe("hidden while it waits (a privacy list)", () => {
  const m = computer("Tiny Mac H");
  beforeAll(() => m.setUp());
  const listed = (lib: string) => {
    const q = buildAssetQuery(lib);
    return (d.prepare(q.sql).all(...q.params) as { id: string }[]).map((r) => r.id);
  };
  let token = "";

  it("a clip moved into a left-out folder while another folder's drive is away is hidden at once, not trashed", async () => {
    const a = await m.index("A", "Day/hideme.mov", 720);
    const c = clip(720);
    d.prepare("UPDATE assets SET title = 'hideme' WHERE id = ?").run(c.id);
    indexAsset(d, c.id);
    const share = await app.request(`/api/library/${a.library}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: { kind: "asset", id: c.id }, scope: "view" }) });
    token = ((await share.json()) as { token: string }).token;
    const seen = async () => ({
      list: listed(a.library).includes(c.id),
      search: searchLibrary(a.library, "hideme").length > 0,
      play: (await app.request(`/api/library/media/${a.versionId}/thumb`)).status,
      share: (await app.request(`/api/library/s/${token}/media/${a.versionId}/thumb`)).status,
      detail: (await app.request(`/api/library/${a.library}/assets/${c.id}`)).status,
    });
    expect(await seen()).toEqual({ list: true, search: true, play: 200, share: 200, detail: 200 });
    await m.away("B");
    await m.list("A", [{ rel: "Private/hideme.mov", q: 720 }]);
    expect([trashed(720), hidden(720)]).toEqual([false, true]);
    expect(await seen()).toEqual({ list: false, search: false, play: 404, share: 404, detail: 404 });
  });

  it("a restart between listings keeps it hidden", async () => {
    forgetOnRestart();
    await m.away("B");
    await m.list("A", [{ rel: "Private/hideme.mov", q: 720 }]);
    expect([trashed(720), hidden(720)]).toEqual([false, true]);
  });

  it("once every folder is read: trashed when the file is gone (no longer hidden only), shown when it turned up", async () => {
    await m.index("A", "Day/gone.mov", 721);
    await m.index("A", "Day/found.mov", 722);
    await m.list("A", [{ rel: "Private/gone.mov", q: 721 }, { rel: "Private/found.mov", q: 722 }, { rel: "Private/hideme.mov", q: 720 }]);
    expect([hidden(721), hidden(722)]).toEqual([true, true]);
    await m.list("C", []);
    await m.list("B", [{ rel: "found.mov", q: 722 }]);
    expect([trashed(721), hidden(721)]).toEqual([true, false]);
    expect([trashed(722), hidden(722)]).toEqual([false, false]);
  });

  it("a file moved back out of the left-out folder shows its clip again", async () => {
    await m.index("A", "Day/back.mov", 723);
    await m.away("B");
    await m.list("A", [{ rel: "Private/back.mov", q: 723 }]);
    expect(hidden(723)).toBe(true);
    await m.list("A", [{ rel: "Day/back.mov", q: 723 }]);
    expect([trashed(723), hidden(723)]).toEqual([false, false]);
  });

  it("a clip with a second known place outside a left-out folder stays shown while it waits", async () => {
    await m.index("A", "Day/two.mov", 724);
    await m.list("C", [{ rel: "two.mov", q: 724 }]);
    await m.away("B");
    await m.list("A", [{ rel: "Private/two.mov", q: 724 }]);
    expect([trashed(724), hidden(724)]).toEqual([false, false]);
  });
});

describe("a clip hidden on one computer is never taken over by another that once had it", () => {
  const x = computer("Tiny Mac X");
  const y = computer("Tiny Mac Y");
  beforeAll(async () => {
    await x.setUp();
    await y.setUp();
  });

  it("waits on X while Y lists all its folders, before and after a restart, and is shown once X finds it", async () => {
    const at = await x.index("A", "Day/two.mov", 740);
    // Y had it once: that place is gone
    d.prepare("INSERT INTO version_places (version_id, device, folder_id, path, bytes, confirmed_at, checked_at, state, source) VALUES (?, ?, ?, ?, 10, 0, 0, 'gone', 'scan')").run(
      at.versionId, y.mac.id, y.ids.A, `${y.roots.A}/two.mov`,
    );
    await x.list("A", [{ rel: "Private/two.mov", q: 740 }]);
    expect([trashed(740), hidden(740)]).toEqual([false, true]);
    const yLists = async () => {
      for (let i = 0; i < 2; i++) for (const k of ["A", "B", "C"] as const) await y.list(k, []);
    };
    await yLists();
    expect([trashed(740), hidden(740)]).toEqual([false, true]);
    forgetOnRestart();
    await yLists();
    expect([trashed(740), hidden(740)]).toEqual([false, true]);
    await x.list("A", [{ rel: "Private/two.mov", q: 740 }]);
    await x.list("C", []);
    await x.list("B", [{ rel: "two.mov", q: 740 }]);
    expect([trashed(740), hidden(740)]).toEqual([false, false]);
  });
});

describe("a paged listing cut by a restart", () => {
  const m = computer("Tiny Mac P");
  beforeAll(() => m.setUp());

  it("never counts as a whole listing of its folder", async () => {
    await m.index("C", "x.mov", 750);
    await m.page("B", "pg", false, [{ rel: "early/other.mov", q: 751 }]);
    forgetOnRestart();
    // the original moved into the part of B already read, a copy into A's Private
    await m.list("A", [{ rel: "Private/x.mov", q: 750 }]);
    await m.page("B", "pg", true, [{ rel: "late/other.mov", q: 752 }]);
    await m.list("C", []);
    expect(trashed(750)).toBe(false);
  });
});

describe("a computer with no Media folders any more, or no longer paired", () => {
  it("settles its waiting clips on what is known: nothing stays hidden for good", async () => {
    const e = computer("Tiny Mac E");
    await e.setUp();
    await e.index("A", "Day/e.mov", 770);
    await e.away("B");
    await e.list("A", [{ rel: "Private/e.mov", q: 770 }]);
    expect(hidden(770)).toBe(true);
    await changeStorage("tia", (st) => {
      st.folders = st.folders.filter((f) => f.origin.host !== e.mac.id);
    });
    await applyReport(e.mac, [], (t += 1000));
    expect(hidden(770)).toBe(false);

    const w = computer("Tiny Mac W");
    await w.setUp();
    await w.index("A", "Day/w.mov", 771);
    await w.away("B");
    await w.list("A", [{ rel: "Private/w.mov", q: 771 }]);
    expect(hidden(771)).toBe(true);
    forgetOnRestart();
    await revokeDevice(w.mac.id);
    // no longer paired: silent from when it is first missed, then its clip goes to the trash like a silent computer's
    const z = computer("Tiny Mac Z");
    await z.setUp();
    await z.list("A", []);
    expect([trashed(771), hidden(771)]).toEqual([false, true]);
    await applyReport(z.mac, [], t + 15 * DAY);
    expect([trashed(771), hidden(771)]).toEqual([true, false]);
  });
});

describe("the moved-in look", () => {
  it("is led by the fingerprint index, never by every place of a computer", () => {
    const plan = (d.prepare(`EXPLAIN QUERY PLAN ${MOVED_IN}`).all(quick(1), 10, "dev", "/x", "[]") as { detail: string }[]).map((r) => r.detail);
    expect(plan[0]).toMatch(/^SEARCH v USING INDEX versions_quick/);
  });
});

describe("a place this server's watch marks found inside a left-out folder", () => {
  const m = computer("Tiny Mac S");
  beforeAll(() => m.setUp());

  it("is no known place: the clip stays hidden", async () => {
    const at = await m.index("A", "Day/s.mov", 780);
    await m.away("B");
    await m.list("A", [{ rel: "Private/s.mov", q: 780 }]);
    expect(hidden(780)).toBe(true);
    // refreshMissing finds the file the clip reads at its left-out path again (watch.ts serverPlace)
    d.prepare("INSERT INTO version_places (version_id, device, folder_id, path, bytes, confirmed_at, checked_at, state, source) VALUES (?, ?, '', ?, 10, 0, 0, 'found', 'server-disk')").run(
      at.versionId, m.mac.id, `${m.roots.A}/Private/s.mov`,
    );
    await m.away("B");
    expect([trashed(780), hidden(780)]).toEqual([false, true]);
  });
});

describe("a computer that stops reporting (silent for 14 days: treated as gone)", () => {
  it("at 13 days its hidden clip stays hidden; past 14 it goes to the trash, never deleted, Restore brings it back, and the status says so", async () => {
    const q = computer("Tiny Mac Q");
    const other = computer("Tiny Mac R");
    await q.setUp();
    await other.setUp();
    await q.index("A", "Day/q.mov", 790);
    await q.away("B");
    await q.list("A", [{ rel: "Private/q.mov", q: 790 }]);
    expect(hidden(790)).toBe(true);
    const seen = deviceOf(q.mac.id)!.lastSeen ?? deviceOf(q.mac.id)!.createdAt;
    await applyReport(other.mac, [], seen + 13 * DAY);
    expect([trashed(790), hidden(790)]).toEqual([false, true]);
    await applyReport(other.mac, [], seen + 15 * DAY);
    const c = clip(790);
    expect([c.trashed_at !== null, c.left_hidden_at]).toEqual([true, null]);
    const line = (name: string) => libraryStatus(c.library_id).leftOut?.find((x) => x.computer === name);
    expect(line("Tiny Mac Q")).toEqual({ computer: "Tiny Mac Q", clips: 1 });
    setTrashedAt(c.id, null); // Restore
    expect([trashed(790), hidden(790)]).toEqual([false, false]);
    expect(line("Tiny Mac Q")).toBeUndefined();
  });

  it("one that reports again before 14 days settles as usual, with no status line", async () => {
    const u = computer("Tiny Mac U");
    await u.setUp();
    await u.index("A", "Day/u.mov", 791);
    await u.away("B");
    await u.list("A", [{ rel: "Private/u.mov", q: 791 }]);
    expect(hidden(791)).toBe(true);
    touchDevice(u.mac.id);
    await u.list("C", []);
    await u.list("B", [{ rel: "u.mov", q: 791 }]);
    expect([trashed(791), hidden(791)]).toEqual([false, false]);
    expect(libraryStatus(clip(791).library_id).leftOut?.find((x) => x.computer === "Tiny Mac U")).toBeUndefined();
  });
});
