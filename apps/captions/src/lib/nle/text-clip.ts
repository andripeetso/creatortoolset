import { PICTURE_SIDE_MAX } from "@contracts/design";
import { freeTrack, place, type NleSource, type NleTimeline } from "./model";
import { picturesAt } from "./picture";
import { shotSource } from "./shot";

// A text clip is a Design frame on the timeline (contracts/editor.ts EdjDesignSource): its design is edited with
// Design's own panels, and the clip plays the frame's PNG (api/designs.ts renders), drawn again at a new path after
// each change. A new one starts as a pending source (its words, no design yet) that the editor makes and fills in.

export const TEXT_SECONDS = 5;
export const isDesign = (s: NleSource | undefined): boolean => s?.kind === "design";

/** A design source whose design is not made yet: `pending` names the making, `words` are its first words. */
export const pendingText = (tl: NleTimeline, words: string): NleSource => ({
  kind: "design", pending: Math.random().toString(36).slice(2, 10), words, w: tl.timeline.width || 1080, h: tl.timeline.height || 1920,
});

/** A design clip of `source` laid 5 s at frame `at` on the first free picture track above V1 (a new one when all are taken). */
export function placeText(tl: NleTimeline, source: NleSource, at: number): { tl: NleTimeline; key: string } {
  const len = Math.round(TEXT_SECONDS * tl.timeline.fps);
  const t = freeTrack(tl, "V", at, at + len, 2);
  let src = "text1";
  for (let n = 2; src in t.tl.sources; n++) src = `text${n}`;
  const made = place({ ...t.tl, sources: { ...t.tl.sources, [src]: source } }, [{ track: t.id, item: { src, rec: at, len, in: 0 } }]);
  return { tl: made.tl, key: made.keys[0]! };
}

/** What a design source plays: its PNG from the server; nothing while it is made, or once its design is gone (a red clip). */
export function designFile(s: NleSource, gone: ReadonlySet<string>): { url: string; why?: string; grab?: true } {
  const path = typeof s.path === "string" ? s.path : "";
  if (!path || typeof s.design !== "string") return { url: "", why: typeof s.failed === "string" ? s.failed : "Drawing the text" };
  if (gone.has(path)) return { url: "", why: "Its design was deleted" };
  return { url: `/api/designs/${encodeURIComponent(s.design)}/renders/${path.split("/").pop()}`, grab: true };
}

/** Picture pixels a design pixel for a source's PNG: the largest zoom its clips reach (keys too), at most PICTURE_SIDE_MAX a side. */
export function renderScale(tl: NleTimeline, src: string, w: number, h: number): number {
  const zooms = Object.values(tl.tracks).flatMap((t) => t.items.filter((i) => i.src === src).flatMap((i) => [i.zoom ?? 1, ...(i.keys?.zoom ?? []).map((k) => k[1])]));
  return Math.min(Math.max(1, ...zooms), PICTURE_SIDE_MAX / Math.max(w, h));
}

/**
 * Whether the viewer's frame at `f` may be drawn into a design (Design on This Frame): something shows there, and every
 * picture there (a shot's other pictures too) is a design or a file the page marked `grab` (a blurred copy, the
 * person's own file). Anything else, a catalog original among them, never is.
 */
export function canGrab(tl: NleTimeline, f: number, fileOf: (src: string) => { url: string; grab?: true } | null): boolean {
  const srcs = picturesAt(tl, f)
    .filter((p) => p.item.fx !== "flash")
    .flatMap(({ item }) => (["main", "under", 1, 2] as const).map((pic) => shotSource(item, pic)).filter((s): s is string => !!s));
  return srcs.length > 0 && srcs.every((s) => {
    if (isDesign(tl.sources[s])) return true;
    const file = fileOf(s);
    return !!file?.url && file.grab === true;
  });
}
