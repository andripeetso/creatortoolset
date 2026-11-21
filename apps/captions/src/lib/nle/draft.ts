// This app's own draft (contracts/editor.ts Timeline) as the editor holds it (model.ts NleTimeline) and back. Every
// field either side doesn't know rides along. Two differences: sound is `gainDb` there and `gain_db` here, and a
// picture's zoom 1 is the source fitted inside the frame there (api/editor/framing.ts fitted) but covering it here on
// the tracks that cover (picture.ts covers), so zoom is scaled by the source's own ratio of the two.

import { markerToEdj, markerToPublic, type EdjMarker, type Timeline } from "@contracts/editor";
import type { NleItem, NleTimeline } from "./model";
import { covers } from "./picture";

/** zoom here ÷ zoom there for a source of w × h on a W × H timeline (1 for a sound, or a track that fits rather than covers) */
function ratio(track: string, s: { w?: unknown; h?: unknown } | undefined, W: number, H: number): number {
  const w = Number(s?.w);
  const h = Number(s?.h);
  if (track[0] !== "V" || !covers(track) || !(w > 0 && h > 0)) return 1;
  return Math.min(W / w, H / h) / Math.max(W / w, H / h);
}
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

type Tracks = Record<string, { items: Record<string, unknown>[]; [k: string]: unknown }>;

/** A draft as the editor opens it. */
export function toNle(tl: Timeline): NleTimeline {
  const { name, fps, width, height, sources, tracks, markers, processing, ...rest } = tl;
  const out: Record<string, NleTimeline["tracks"][string]> = {};
  for (const [id, t] of Object.entries(tracks as unknown as Tracks)) {
    out[id] = {
      ...t,
      items: t.items.map(({ gainDb, zoom: z, ...it }) => {
        const zoom = ((z as number | undefined) ?? 1) * ratio(id, sources[it.src as string], width, height);
        return { ...it, ...(gainDb !== undefined ? { gain_db: gainDb } : {}), ...(zoom !== 1 ? { zoom } : {}) } as NleItem;
      }),
    };
  }
  return {
    ...rest,
    timeline: { name, fps, width, height, ...(processing ? { processing } : {}) },
    sources: sources as unknown as NleTimeline["sources"],
    tracks: out,
    markers: (markers ?? []).map(({ rec, ...m }) => ({ ...m, ...markerToEdj({ rec, ...m }) })),
  };
}

/** The editor's saved timeline as a draft (what the server keeps and renders). */
export function fromNle(nle: NleTimeline): Timeline {
  const { timeline, sources, tracks, markers, edj_version: _v, ...rest } = nle;
  const { name, fps, width, height, duration: _d, ...more } = timeline;
  const W = Number(width);
  const H = Number(height);
  const out: Tracks = {};
  for (const [id, t] of Object.entries(tracks)) {
    out[id] = {
      ...t,
      items: t.items.map(({ gain_db, _k, ...it }) => {
        const zoom = r6((it.zoom ?? 1) / ratio(id, sources[it.src], W, H));
        const { zoom: _z, ...left } = it;
        return { ...left, ...(gain_db !== undefined ? { gainDb: gain_db } : {}), ...(zoom !== 1 ? { zoom } : {}) };
      }),
    };
  }
  return {
    ...rest,
    ...more,
    name: String(name ?? ""),
    fps,
    width: W,
    height: H,
    sources: sources as unknown as Timeline["sources"],
    tracks: out as unknown as Timeline["tracks"],
    markers: ((markers ?? []) as unknown as EdjMarker[]).map(({ frame, dur, ...m }) => ({ ...m, ...markerToPublic({ frame, dur, ...m }), ...(dur && dur !== 1 ? { dur } : {}) })),
  } as Timeline;
}
