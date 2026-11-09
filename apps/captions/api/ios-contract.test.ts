/**
 * Golden contract for the server paths the companion iPhone app calls.
 *
 * The list lives in `__fixtures__/ios-paths.json` (method, path, and the shape
 * the app decodes). This test boots the app in-process and checks each entry:
 *
 * - `route`: the app's route table (`app.routes`, sub-apps flattened) has the
 *   method and path. An HTTP 404 can't be used for this: the app answers JSON
 *   404s for unknown paths under some sub-apps too. Route checks cannot see a
 *   changed body shape, only a missing route.
 * - `list`: a GET on a fresh database answers 200 with the array or object the
 *   app decodes, and the listed keys are present.
 * - `static`: a file the app serves from its fonts folder answers 200. The
 *   static root only exists after a build, so the check reads the source folder
 *   and asks for one of its files.
 *
 * Paths on the catalog server (`/catalog/...`, the iPhone app's catalog base)
 * are not routes of this app and are pending.
 *
 * Entries with `pending` are known gaps. They are printed and do not fail the
 * suite; the reason names the change that closes them. A pending entry that
 * now passes is printed too, so its marker can be removed.
 *
 * Per-path notes:
 * - auth.login, auth.check: the Creator Toolset login (`cap_auth`), used by the
 *   analyzer link and the dashboard. The catalog login under `/catalog` sets
 *   `ba_auth` instead, and the iPhone app reads only that name there; a catalog
 *   login against a server that sets `cap_auth` would silently send no cookie.
 *   That is why the catalog login is pending, not passing.
 * - editor.worker: the Mac worker status endpoint; it goes with the legacy
 *   worker sunset, so it stays on the list until then.
 * - editor.chat-*: the AI Editor chat; it is in the plug-in editor only.
 * - finals.* : the app's Finals screen calls the old `/api/library` paths with
 *   the Finals shape. The public app mounts the storage library at the same
 *   base path with a different meaning (`{ libraries }`, and `/media/:versionId/:kind`),
 *   so these paths answer only when the old-path router is mounted (a plug-in that
 *   serves them). With that router mounted the entries must pass, and their
 *   markers are dropped (see `oldPathRouter` below).
 * - catalog.*: the catalog server's endpoints, behind nginx at `/catalog/` (the
 *   catalog server, which stays where it is). This app has no such routes, so
 *   they are listed as answered by the catalog and not probed here. A route that
 *   answers on this app (e.g. `/api/clips`) is a different thing and is not counted.
 * - fonts.file: the app serves its fonts folder from the build output; the check
 *   reads the source folder.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "ios-contract-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "ios-contract-secret";

const { findUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;

type Shape = { type: "array" } | { type: "object"; keys?: string[] };
type Entry = {
  id: string;
  method: string;
  path: string;
  probe: "route" | "list" | "static";
  shape?: Shape;
  pending?: string;
};

/** Known gaps by entry id: the change that closes each one. Entries listed here are printed, not failed. */
const PENDING: Record<string, string> = {
  "editor.worker": "device status replaces the Mac worker endpoint: ed-device-registry, then legacy-sunset-public",
  "editor.draft-preview": "public editor has no job queue, revise or preview yet: ed-device-registry, then ba-editor-plugin",
  "editor.draft-revise": "public editor has no job queue, revise or preview yet: ed-device-registry, then ba-editor-plugin",
  "editor.jobs": "public editor has no job queue, revise or preview yet: ed-device-registry, then ba-editor-plugin",
  "editor.chat-get": "AI Editor chat moves into the plug-in: ba-editor-plugin",
  "editor.chat-post": "AI Editor chat moves into the plug-in: ba-editor-plugin",
  "editor.chat-delete": "AI Editor chat moves into the plug-in: ba-editor-plugin",
  // The four media and cover entries answer only when the old-path router is mounted (a plug-in); the public build has none.
  "finals.media-thumb": "finals old-path router: a plug-in mounts it (the iPhone's Finals paths)",
  "finals.media-play": "finals old-path router: a plug-in mounts it (the iPhone's Finals paths)",
  "finals.media-download": "finals old-path router: a plug-in mounts it (the iPhone's Finals paths)",
  "finals.stack-cover": "finals old-path router: a plug-in mounts it (the iPhone's Finals paths)",
  "finals.list": "finals old-path router: a plug-in mounts it (the iPhone's Finals paths)",
};

/** The Finals old-path router is mounted (a plug-in's), which answers the iPhone's Finals paths on the same base path. */
const oldPathRouter = () => mounted("GET", "/api/library/media/:id/thumb");
/** The AI Editor root routes a plug-in mounts for an admin are mounted: chat, worker status, jobs, draft preview and revise. */
const editorRoot = () => mounted("GET", "/api/editor/chat");
/** The catalog server's paths (nginx `/catalog/`, the catalog server): not this app's routes, so not probed here. */
const onCatalog = (e: Entry) => e.path.startsWith("/catalog/");

const fixture = (JSON.parse(
  readFileSync(fileURLToPath(new URL("./__fixtures__/ios-paths.json", import.meta.url)), "utf8"),
) as Entry[]).map((e) => ({ ...e, pending: (e.id.startsWith("finals.") && oldPathRouter()) || (e.id.startsWith("editor.") && editorRoot()) ? undefined : PENDING[e.id] }));

const fontsDir = fileURLToPath(new URL("../public/fonts", import.meta.url));

// The install's admin account (boot creates it): the AI Editor's root paths answer an admin only.
const auth = `Bearer ${newApiKey(findUser("admin")!, "full")}`;

/** Fills each `:param` with an id that does not exist (`:n` a version number, `:file` a file name). */
function concretePath(p: string): string {
  return p.replace(/:(\w+)/g, (_, name: string) => (name === "n" ? "1" : name === "file" ? "file.mp4" : "ios-missing"));
}

/** Route table lookup: `:name` parameters and Hono's `{regex}` suffixes compare as one placeholder. */
function mounted(method: string, p: string): boolean {
  const norm = (s: string) => s.split("?")[0]!.replace(/:\w+(\{[^}]*\})?/g, ":").replace(/\/+$/, "") || "/";
  const want = norm(p);
  return (app.routes as Array<{ method: string; path: string }>).some(
    (r) => (r.method === method || r.method === "ALL" || (method === "HEAD" && r.method === "GET")) && norm(r.path) === want,
  );
}

/** Null when the entry matches its contract, otherwise the reason it does not. */
async function check(e: Entry): Promise<string | null> {
  const notMounted = "not mounted (no such method and path in the route table)";
  if (e.probe === "static") {
    return readdirSync(fontsDir).some((f) => !f.startsWith(".")) ? null : "no font files in the fonts folder";
  }
  if (!mounted(e.method, e.path)) return notMounted;
  if (e.probe === "route") return null;
  const res = await app.request(concretePath(e.path), { method: e.method, headers: { authorization: auth } });
  if (res.status !== 200) return `expected 200, got ${res.status}`;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return "body is not JSON";
  }
  const shape = e.shape!;
  if (shape.type === "array") return Array.isArray(data) ? null : "expected an array";
  if (typeof data !== "object" || data === null || Array.isArray(data)) return "expected an object";
  const missing = (shape.keys ?? []).filter((k) => !(k in data));
  return missing.length ? `missing keys: ${missing.join(", ")}` : null;
}

describe("the iPhone app's server paths", () => {
  afterAll(async () => {
    // users.json is written in the background (persist), and a write still queued would land in the removed folder
    await new Promise((r) => setTimeout(r, 100));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("the fixture is well formed and every entry is unique", () => {
    const seen = new Set<string>();
    for (const e of fixture) {
      expect(e.path.startsWith("/"), e.id).toBe(true);
      expect(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], e.id).toContain(e.method);
      expect(e.probe === "list" ? e.shape !== undefined : e.shape === undefined, e.id).toBe(true);
      const key = `${e.method} ${e.path}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("the probe is calibrated: a path nobody mounts reads as not mounted", async () => {
    const bogus: Entry = { id: "calibration", method: "GET", path: "/api/review/assets/:id/no-such-part", probe: "route" };
    expect(await check(bogus)).toMatch(/^not mounted/);
    const real: Entry = { id: "calibration-real", method: "GET", path: "/api/review/assets/:id", probe: "route" };
    expect(await check(real)).toBeNull();
  });

  it("every path the app calls is mounted with the shape it decodes, except the printed known gaps", async () => {
    const probed = fixture.filter((e) => !onCatalog(e));
    const catalogPaths = fixture.filter(onCatalog);
    const results = await Promise.all(probed.map(async (e) => ({ e, reason: await check(e) })));
    const broken = results.filter((r) => r.reason && !r.e.pending);
    const pending = results.filter((r) => r.reason && r.e.pending);
    const nowPassing = results.filter((r) => !r.reason && r.e.pending);

    const line = (r: (typeof results)[number]) => `  ${r.e.method} ${r.e.path} (${r.e.id}): ${r.reason ?? "ok"}`;
    console.log(
      [
        `iOS contract: ${probed.length} paths on this app, ${results.length - broken.length - pending.length} ok, ${broken.length} broken, ${pending.length} known gaps`,
        ...(catalogPaths.length ? [`Answered by the catalog server, not probed here: ${catalogPaths.length} paths`] : []),
        ...(broken.length ? ["Broken:", ...broken.map(line)] : []),
        ...(pending.length ? ["Known gaps (pending):", ...pending.map((r) => `${line(r)} [${r.e.pending}]`)] : []),
        ...(nowPassing.length ? ["Pending entries that pass the probe (the probe cannot see the meaning; check it before dropping the marker):", ...nowPassing.map((r) => `  ${r.e.id}`)] : []),
      ].join("\n"),
    );

    expect(broken.map((r) => `${r.e.method} ${r.e.path}: ${r.reason}`)).toEqual([]);
    // With the plug-in's Finals and AI Editor routers mounted, no app path may stay pending.
    if (oldPathRouter() && editorRoot()) {
      expect(pending.map((r) => `${r.e.method} ${r.e.path}`)).toEqual([]);
    }
  });
});
