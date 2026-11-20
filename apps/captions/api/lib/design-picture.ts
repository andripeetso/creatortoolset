import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Design, DesignPage } from "../../contracts/design";
import { facesOf } from "../../src/lib/design/fonts";
import { textFonts } from "../../src/lib/design/runs";
import { startTask } from "../work/tasks";
import { paintPictures } from "../../src/lib/design/paint";

/**
 * A design's pages as small pictures, for the AI that designed them to look at (GET /api/designs/:id/look). They are
 * drawn by the `design-pages` computer task (work/tasks/design-pages.ts) in a headless browser, by the same function
 * as the designer's canvas (src/lib/design/picture.ts), so what the AI sees is what the person sees.
 *
 * Best effort. A drawing that takes too long or a crash give no pictures and one line saying why: the design is saved
 * either way. Drawn on the person's Mac, the answer has no pictures yet and says so; the next look has them (kept beside
 * the design's pictures in `.look.json` while the pages are the same).
 */

export interface PagePicture {
  page: number;
  /** base64: a JPEG, or (asked for with `png`) a PNG that keeps what is see-through */
  jpeg?: string;
  png?: string;
  /** the words on the page that do not fit their box, as the AI is told them */
  spills: string[];
  /** what the drawing worked out for each text that shrinks: the size it is drawn at and its lines (left out by an older drawing) */
  drawn?: string[];
}
export interface Look {
  pictures: PagePicture[];
  /** why there are none */
  why?: string;
}

/** What the task draws: the pages asked for, their pictures and fonts by name (`files`: name → where the server has it). */
export interface DesignPagesInput {
  width: number;
  height: number;
  pages: Array<{ n: number; page: DesignPage }>;
  fonts: string[];
  files: Record<string, string>;
  /** a PNG of each page at `scale` picture pixels a design pixel, in place of a small JPEG */
  png?: { scale: number };
  key: string;
  to: string;
}

export const NO_BROWSER = "No pictures of the pages: this server has no browser to draw them with yet";
export const FETCHING = "No pictures of the pages yet: the browser that draws them is being fetched now (once, about 150 MB, from Playwright's download server; a captioned export uses the same one). Look again in a minute or two";
const DRAWING = "No pictures of the pages yet: your computer is drawing them. Look again in a minute";

/**
 * Pictures of the pages numbered in `which` (1 = the first). `dir`: the design's pictures folder. `fonts`: the person's
 * own fonts, each family's file. `png`: each page as a PNG that keeps what is see-through, `scale` picture pixels a
 * design pixel (a UHD frame at 2: 7680 × 4320; PICTURE_SIDE_MAX a side), in place of the AI's small JPEGs. Hidden and
 * reference layers are never drawn, and their pictures never sent.
 */
export async function pagePictures(d: Design, pages: DesignPage[], which: number[], dir: string, fonts: Record<string, string> = {}, png?: { scale: number }): Promise<Look> {
  // a test draws nothing unless it asks to: a browser is not part of a unit test
  if (process.env.NODE_ENV === "test" && !process.env.DESIGN_PICTURES) return { pictures: [], why: NO_BROWSER };
  const asked = which.flatMap((n) => (pages[n - 1] ? [{ n, page: pages[n - 1]! }] : []));
  const files: Record<string, string> = {};
  const families = new Set<string>();
  for (const { page } of asked)
    for (const pic of paintPictures(page)) files[`pic-${pic}`] = path.join(dir, pic);
  for (const { page } of asked)
    for (const l of page.layers) {
      if (l.type === "image" && !l.hidden && !l.reference) files[`pic-${l.picture}`] = path.join(dir, l.picture);
      // the text's own font and its runs', with every face of their families: a weight or a slant is one of those
      if (l.type === "text")
        for (const face of textFonts(l).flatMap((f) => facesOf(f, Object.keys(fonts))))
          if (fonts[face.family]) {
            families.add(face.family);
            files[`font-${face.family}`] = fonts[face.family]!;
          }
    }
  const input = { width: d.width, height: d.height, pages: asked, fonts: [...families], files, ...(png ? { png } : {}) };
  const key = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  // a PNG is kept apart: the AI's next look still finds its own
  const kept = path.join(dir, png ? ".png-look.json" : ".look.json");
  const was = (await readFile(kept, "utf8").then(JSON.parse, () => null)) as { key?: string; look?: Look } | null;
  if (was?.key === key && was.look) return was.look;
  const r = await startTask<DesignPagesInput, Look>("design-pages", d.id, d.owner, null, { ...input, key, to: kept });
  return r.state === "done" ? r.result : { pictures: [], why: r.line ? `No pictures of the pages yet: ${r.line}` : DRAWING };
}
