import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright-chromium";
import type { DesignPage, PictureSpec } from "../../../contracts/design";
import { installExportBrowser, rendererUrl } from "../../caption-frames";
import { FETCHING, NO_BROWSER, type DesignPagesInput, type Look, type PagePicture } from "../../lib/design-picture";
import { ffmpeg } from "../../library/media/run";
import { taskKind } from "../tasks";

/**
 * A design's pages drawn in a headless browser (lib/design-picture.ts asks for them): on the person's Mac, which has
 * the browser caption exports use, or here where the server's video work is on. Drawing is processing (D7).
 *
 * That browser runs unsandboxed and reads files. What goes into it is kept to what the app made itself: a drawing is
 * markup the check wrote again from known shapes (safeSvg), shown as a picture, where nothing runs or loads; and an
 * uploaded picture never reaches the browser as it was uploaded: a small copy is written first, and the browser reads that.
 */

/** The picture's width in pixels (a page is never drawn bigger than it is). */
const WIDTH = 560;
/** An uploaded picture's small copy: its longer side at most. */
const SMALL = 1024;
const TIMEOUT_MS = 25_000;

type RendererWindow = { designRenderer?: { draw(spec: PictureSpec): Promise<{ jpeg: string; spills: string[] }> } };

/** The page's pictures as data addresses of their small copies (made once a run, in `dir`). */
async function smallPictures(page: DesignPage, dir: string, file: (name: string) => Promise<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const l of page.layers) {
    if (l.type !== "image" || l.hidden || out[l.picture]) continue;
    // a JPEG stays a JPEG; a PNG or a WebP becomes a PNG, which keeps what is see-through
    const jpeg = l.picture.endsWith(".jpg");
    const small = path.join(dir, "small", `${l.picture.split(".")[0]}.${jpeg ? "jpg" : "png"}`);
    try {
      if (!(await stat(small).then(() => true, () => false))) {
        await mkdir(path.dirname(small), { recursive: true });
        await ffmpeg(["-i", await file(`pic-${l.picture}`), "-frames:v", "1", "-vf", `scale=w='min(${SMALL},iw)':h='min(${SMALL},ih)':force_original_aspect_ratio=decrease`, ...(jpeg ? ["-q:v", "4", "-f", "mjpeg"] : ["-f", "image2", "-c:v", "png"]), small], true);
      }
      out[l.picture] = `data:image/${jpeg ? "jpeg" : "png"};base64,${(await readFile(small)).toString("base64")}`;
    } catch {
      // a picture that cannot be read is drawn as its grey place
    }
  }
  return out;
}

async function draw(input: DesignPagesInput, dir: string, file: (name: string) => Promise<string>): Promise<Look> {
  let browser: Browser | null = null;
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    void browser?.close().catch(() => {});
  }, TIMEOUT_MS);
  try {
    const { chromium } = await import("playwright-chromium");
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--allow-file-access-from-files", "--disable-dev-shm-usage"] });
    const tab = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    await tab.goto(rendererUrl(), { waitUntil: "load" });
    await tab.waitForFunction(() => Boolean((globalThis as unknown as RendererWindow).designRenderer), undefined, { timeout: 10_000 });
    const pictures: PagePicture[] = [];
    for (const { n, page } of input.pages) {
      // each frame at its own size, no wider than the picture's width
      const width = page.w ?? input.width;
      // the person's own fonts this frame's words are set in, each as its file's address (the drawing page is a file itself)
      const own: Record<string, string> = {};
      // (every face the pages ask for: a run's font, and the faces of a family a weight or a slant is drawn in)
      for (const f of input.fonts) if (!own[f]) own[f] = pathToFileURL(await file(`font-${f}`)).href;
      const spec: PictureSpec = { width, height: page.h ?? input.height, page, pictures: await smallPictures(page, dir, file), ...(Object.keys(own).length ? { fonts: own } : {}), scale: Math.min(1, WIDTH / width) };
      pictures.push({ page: n, ...(await tab.evaluate((s) => (globalThis as unknown as RendererWindow).designRenderer!.draw(s), spec)) });
    }
    return { pictures };
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    // ponytail: Playwright's missing-browser message (1.62), as api/caption-frames.ts reads it
    if (said.includes("Executable doesn't exist")) {
      // fetched once, behind this answer (askers while it runs share the one fetch): nobody waits for it, and one
      // that fails is tried again at the next look
      void installExportBrowser().catch(() => {});
      return { pictures: [], why: FETCHING };
    }
    if (said.includes("playwright-chromium")) return { pictures: [], why: NO_BROWSER };
    return { pictures: [], why: late ? "No pictures of the pages: drawing them took too long" : `No pictures of the pages: ${said.split("\n")[0]!.slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
}

// one browser at a time: a second asker waits for the first to be done, and no more than a few wait
let line: Promise<unknown> = Promise.resolve();
let waiting = 0;
const MAX_WAITING = 4;

taskKind<DesignPagesInput, Look>("design-pages", {
  serve: (t, name) => (t.input as DesignPagesInput).files[name],
  // the browser comes with the Mac app (apps/mac/README.md); the PC helper has none
  can: (d) => d.report?.machine?.os === "mac",
  async run(input, ctx) {
    if (waiting >= MAX_WAITING) return { result: { pictures: [], why: "No pictures of the pages: the computer is drawing others just now" } };
    waiting++;
    const mine = line.then(() => draw(input, ctx.dir, ctx.file)).finally(() => waiting--);
    line = mine.catch(() => {});
    return { result: await mine };
  },
  // kept for the next look: a computer's drawing comes after the answer that asked for it
  async apply(t, look) {
    if (!look.pictures.length) return;
    await mkdir(path.dirname(t.input.to), { recursive: true });
    await writeFile(t.input.to, JSON.stringify({ key: t.input.key, look }));
  },
});
