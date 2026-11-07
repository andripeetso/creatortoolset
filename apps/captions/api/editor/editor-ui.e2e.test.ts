import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The one browser smoke test for /editor: a new edit from a library clip, with the script step's AI stubbed, through to
// its draft, preview and download links. It starts the app's own Vite server in this process and one headless Chrome.
// It runs alone:
//   EDITOR_E2E=1 CT_SCRATCH_DIR=<a scratch folder on a big disk> pnpm -s exec vitest run api/editor/editor-ui.e2e.test.ts
// Everything it writes lives under CT_SCRATCH_DIR and is removed at the end. Not part of the server typecheck.

const enabled = process.env.EDITOR_E2E === "1";
type Any = any;
let dir = "";
let base = "";
let server: Any = null;
let browser: Any = null;
let stopWorker: (() => void) | null = null;

beforeAll(async () => {
  if (!enabled) return;
  const scratch = process.env.CT_SCRATCH_DIR;
  if (!scratch) throw new Error("Set CT_SCRATCH_DIR to a folder on the external disk");
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(path.join(scratch, "editor-ui-"));
  process.env.DATA_DIR = path.join(dir, "data");
  mkdirSync(process.env.DATA_DIR, { recursive: true });
  // APP_SECRET unset: every request is `local`, an admin, the owner of this workspace
  writeFileSync(
    path.join(process.env.DATA_DIR, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ id: "ws_ui", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [{ username: "local", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }] }],
      invites: [],
      spend: {},
    }),
  );

  // a four-second vertical clip with sound, already transcribed: two sentences
  const { ffmpegCommand } = await import("../ffmpeg-runtime");
  const fixture = path.join(dir, "Tiny Acrobatics take.mp4");
  execFileSync(ffmpegCommand(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=4:size=360x640:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture,
  ]);
  const { blobs, libraryDb } = await import("../library/db");
  const { probe } = await import("../library/media/probe");
  const { saveTranscript } = await import("../library/transcribe");
  const d = libraryDb();
  const key = "libraries/lib_ui/v/ver_ui/source";
  const p = await probe(fixture);
  copyFileSync(fixture, path.join(dir, "put.mp4"));
  await blobs.put(key, path.join(dir, "put.mp4"));
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_ui', 'ws_ui', 'Tiny Acrobatics library', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_ui', 'lib_ui', 'video', 'Tiny Acrobatics take', 'ver_ui', 'local', 0);
  `);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at) VALUES ('ver_ui', 'ast_ui', 1, ?, 1, 'sha-ui', 'video/mp4', ?, 'ready', 'local', 0)").run(key, JSON.stringify(p));
  const { indexAsset } = await import("../library/query");
  indexAsset(d, "ast_ui");
  const w = (word: string, s: number, e: number) => ({ w: word, s, e });
  saveTranscript(d, "ver_ui", "deepgram", "en", [], [w("we", 0.5, 0.75), w("roll.", 0.85, 1.1), w("join", 2.1, 2.35), w("us.", 2.45, 2.7)]);

  // the script step's AI, stubbed: one line per sentence, one version
  const { STEPS, startEditorWorker } = await import("./worker");
  const { saveStep } = await import("./store");
  STEPS.script = async ({ edit }) => {
    const t = (n: number) => ({ first: n, last: n, score: 1 });
    await saveStep(edit.id, "plan", {
      lines: [
        { id: "L1", text: "we roll", takes: [t(1)] },
        { id: "L2", text: "join us", takes: [t(2)] },
      ],
      plans: [{ name: "v1", title: "Tiny Acrobatics cut", lines: [{ line: "L1", take: t(1) }, { line: "L2", take: t(2) }] }],
      notes: [],
    });
  };
  stopWorker = startEditorWorker();

  const { createServer } = await import("vite");
  server = await createServer({
    configFile: path.resolve(import.meta.dirname, "../../vite.config.ts"),
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  base = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}/`;
  const { chromium } = await import("playwright-chromium");
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  stopWorker?.();
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("AI Editor in the browser", () => {
  it("creates an edit from a library clip, runs it to a draft and a preview, and offers the downloads", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(new URL("/editor", base).toString());
    await page.getByRole("heading", { name: "AI Editor" }).waitFor({ timeout: 60_000 });

    await page.getByRole("button", { name: "New edit" }).first().click();
    await page.getByRole("button", { name: /Tiny Acrobatics take/ }).click();
    await page.getByLabel("Name").fill("Tiny Acrobatics hook");
    await page.getByRole("button", { name: "Create and run" }).click();

    await page.waitForURL(/\/editor\/[0-9a-f-]{36}$/);
    const version = page.getByRole("article", { name: "Tiny Acrobatics cut" });
    await version.waitFor({ timeout: 90_000 });
    await version.getByRole("link", { name: "Open in Review" }).waitFor({ timeout: 90_000 });
    expect(await version.locator("video").count()).toBe(1);
    const hrefs: string[] = await version.getByRole("link").evaluateAll((as: Any[]) => as.map((a) => a.getAttribute("href")));
    expect(hrefs.filter((h) => h.includes("/export?format=")).map((h) => h.split("format=")[1])).toEqual(["otio", "fcpxml", "zip"]);
    const otio = await page.request.get(new URL(hrefs[0]!, base).toString());
    expect(otio.status()).toBe(200);
    expect(await otio.text()).toContain("Timeline.1");

    // the script table shows each line with its take
    await page.getByRole("cell", { name: "join us" }).waitFor();

    // a phone: the page fits its width (the script table scrolls inside its own box)
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow: number = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    expect(overflow).toBeLessThanOrEqual(0);
    await page.goto(new URL("/editor", base).toString());
    await page.getByRole("link", { name: /Tiny Acrobatics hook/ }).waitFor();
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);
});
