import type { Design, Layer, TextLayer } from "@contracts/design";
import { pagePicture } from "@/lib/design/picture";
import { addPicture, createDesign, pictureId, pictureUrl, saveDesign } from "@/lib/designs";
import type { NleSource } from "./model";

// A text clip's design (lib/nle/text-clip.ts): made at the timeline's size with a see-through frame, and its frame
// drawn as a PNG with what is see-through kept, stored on the server by its content (api/designs.ts renders).

export const FRAME = "p1";

/** A title's first look: big white letters with a dark outline, in the middle of the frame. */
const title = (text: string, w: number, h: number): TextLayer => {
  const m = Math.min(w, h);
  return {
    id: "t1", type: "text", text, font: "Anton", size: Math.round(m * 0.1), color: "#ffffff", align: "center", valign: "middle", fit: "shrink",
    lineHeight: 1.05, outline: { color: "#000000", width: Math.round(m * 0.01) }, x: Math.round(w * 0.07), y: Math.round(h * 0.4), w: Math.round(w * 0.86), h: Math.round(h * 0.2),
  };
};

/** A new design of one see-through frame the timeline's size with `layers` on it (`layers` may add pictures to it first). */
async function frameDesign(w: number, h: number, name: string, layers: (id: string) => Promise<Layer[]>): Promise<Design> {
  const d = await createDesign({ format: w >= h ? "thumbnail" : "cover", name, blank: true, pages: 0 });
  return saveDesign(d.id, { pages: [{ id: FRAME, x: 0, y: 0, w, h, background: "#ffffff", fills: [], layers: await layers(d.id) }] });
}

/** Frame `frame` of the design as a PNG `scale` times its size, kept on the server: the design source that plays it. */
export async function drawFrame(d: Design, frame: string, scale: number): Promise<NleSource> {
  const page = d.pages.find((p) => p.id === frame);
  if (!page) throw new Error("The text's frame is not in its design any more");
  const [w, h] = [page.w ?? d.width, page.h ?? d.height];
  const pictures = Object.fromEntries(d.pictures.map((p) => [p, pictureUrl(d.id, p)]));
  const { png } = await pagePicture({ width: w, height: h, page, pictures, scale, png: true });
  const r = await fetch(`/api/designs/${encodeURIComponent(d.id)}/renders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ png }) });
  const out = (await r.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!r.ok || !out.path) throw new Error(out.error ?? `The text could not be kept (${r.status})`);
  return { kind: "design", design: d.id, frame, path: out.path, w, h };
}

/** A text clip's design with `words` (a title when none), drawn: its design source. */
export async function makeText(words: string, w: number, h: number): Promise<NleSource> {
  const text = words.trim() || "Title";
  return drawFrame(await frameDesign(w, h, text.slice(0, 60), async () => [title(text, w, h)]), FRAME, 1);
}

/** A design of a frame of the video to design over: the frame as a reference layer (shown only while designing). */
export const grabDesign = (frame: File, w: number, h: number): Promise<Design> =>
  frameDesign(w, h, "Design on frame", async (id) => [{ id: "ref", type: "image", picture: await addPicture(id, frame, pictureId(frame)), fit: "cover", reference: true, locked: true, name: "Video frame", x: 0, y: 0, w, h }]);

/** The viewer's picture now as a JPEG the timeline's size: the <video> shown over its canvas, else the canvas.
 *  shortcut: drawn from the viewer as shown on screen, enough to design over; draw it from the file if fine detail matters. */
export async function grabFrame(box: HTMLElement, W: number, H: number): Promise<File> {
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = c.getContext("2d")!;
  const v = [...box.querySelectorAll("video")].find((el) => el.style.visibility === "visible" && el.videoWidth);
  if (v) {
    const k = (v.style.objectFit === "contain" ? Math.min : Math.max)(W / v.videoWidth, H / v.videoHeight);
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(v, (W - v.videoWidth * k) / 2, (H - v.videoHeight * k) / 2, v.videoWidth * k, v.videoHeight * k);
  } else ctx.drawImage(box.querySelector("canvas")!, 0, 0, W, H);
  const blob = await new Promise<Blob | null>((done) => c.toBlob(done, "image/jpeg", 0.9));
  if (!blob) throw new Error("The frame could not be read");
  return new File([blob], "frame.jpg", { type: "image/jpeg" });
}
