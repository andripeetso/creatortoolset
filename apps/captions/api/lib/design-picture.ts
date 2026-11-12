import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright-chromium";
import type { Design, DesignPage, PictureSpec } from "../../contracts/design";
import { installExportBrowser, rendererUrl } from "../caption-frames";
import { ffmpeg } from "../library/media/run";

/**
 * A design's pages as small pictures, for the AI that designed them to look at (GET /api/designs/:id/look). They
 * are drawn in the server's own headless browser, the one caption exports use, by the same function as the
 * designer's canvas (src/lib/design/picture.ts), so what the AI sees is what the person sees.
 *
 * That browser runs unsandboxed and reads files, and until now drew only the app's own captions. What goes into it
 * here is kept to what the app made itself: a drawing is markup the check wrote again from known shapes (safeSvg),
 * shown as a picture, where nothing runs or loads; and an uploaded picture never reaches the browser as it was
 * uploaded: ffmpeg writes a small copy first, and the browser reads that.
 *
 * Best effort. A drawing that takes too long or a crash give no pictures and one line saying why: the design is
 * saved either way. A server that has no such browser yet (the downloaded app, until its first captioned export)
 * starts fetching it, once, as the first export would, and does not wait for it: this answer has no pictures and
 * says the browser is on its way, so the AI can tell the person, and the pictures come with a later look.
 */

export interface PagePicture {
  page: number;
  /** base64 */
  jpeg: string;
  /** the words on the page that do not fit their box, as the AI is told them */
  spills: string[];
}
export interface Look {
  pictures: PagePicture[];
  /** why there are none */
  why?: string;
}

/** The picture's width in pixels (a page is never drawn bigger than it is). */
const WIDTH = 560;
/** An uploaded picture's small copy: its longer side at most. */
const SMALL = 1024;
const TIMEOUT_MS = 25_000;
const NO_BROWSER = "No pictures of the pages: this server has no browser to draw them with yet";
const FETCHING = "No pictures of the pages yet: the browser that draws them is being fetched now (once, about 150 MB, from Playwright's download server; a captioned export uses the same one). Look again in a minute or two";

type RendererWindow = { designRenderer?: { draw(spec: PictureSpec): Promise<{ jpeg: string; spills: string[] }> } };

/** The page's pictures as data addresses of their small copies (made once, kept beside the pictures in `.small/`). */
async function smallPictures(page: DesignPage, dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const l of page.layers) {
    if (l.type !== "image" || l.hidden || out[l.picture]) continue;
    // a JPEG stays a JPEG; a PNG or a WebP becomes a PNG, which keeps what is see-through
    const jpeg = l.picture.endsWith(".jpg");
    const small = path.join(dir, ".small", `${l.picture.split(".")[0]}.${jpeg ? "jpg" : "png"}`);
    try {
      if (!(await stat(small).then(() => true, () => false))) {
        await mkdir(path.dirname(small), { recursive: true });
        await ffmpeg(["-i", path.join(dir, l.picture), "-frames:v", "1", "-vf", `scale=w='min(${SMALL},iw)':h='min(${SMALL},ih)':force_original_aspect_ratio=decrease`, ...(jpeg ? ["-q:v", "4", "-f", "mjpeg"] : ["-f", "image2", "-c:v", "png"]), small], true);
      }
      out[l.picture] = `data:image/${jpeg ? "jpeg" : "png"};base64,${(await readFile(small)).toString("base64")}`;
    } catch {
      // a picture that cannot be read is drawn as its grey place
    }
  }
  return out;
}

async function draw(d: Design, pages: DesignPage[], which: number[], dir: string): Promise<Look> {
  // a test draws nothing unless it asks to: a browser is not part of a unit test
  if (process.env.NODE_ENV === "test" && !process.env.DESIGN_PICTURES) return { pictures: [], why: NO_BROWSER };
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
    const scale = Math.min(1, WIDTH / d.width);
    const pictures: PagePicture[] = [];
    for (const n of which) {
      const page = pages[n - 1];
      if (!page) continue;
      const spec: PictureSpec = { width: d.width, height: d.height, page, pictures: await smallPictures(page, dir), scale };
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

/** Pictures of the pages numbered in `which` (1 = the first). `dir`: the design's pictures folder. */
export function pagePictures(d: Design, pages: DesignPage[], which: number[], dir: string): Promise<Look> {
  if (waiting >= MAX_WAITING) return Promise.resolve({ pictures: [], why: "No pictures of the pages: the server is drawing others just now" });
  waiting++;
  const mine = line.then(() => draw(d, pages, which, dir)).finally(() => waiting--);
  line = mine.catch(() => {});
  return mine;
}
