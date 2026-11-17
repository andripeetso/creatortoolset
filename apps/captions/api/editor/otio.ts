import path from "node:path";
import { TRACKS, type Item, type Timeline, type TimelineSource } from "../../contracts/editor";
import { type Cdl, cdlMeta } from "./grade";
import { motion } from "./carry";
import { dissolveFrames } from "./fcpxml";
import { fitted } from "./framing";
import { meanSpeed } from "./plan";

/**
 * A draft as OpenTimelineIO JSON, written by hand (no package). Clips carry the metadata DaVinci Resolve reads on
 * import (`Resolve_OTIO`: transform, clip volume, link groups, marker notes); other readers ignore it.
 *
 * Units: a clip's source_range is in the file's timecode frames at the timeline rate (start timecode + `in`), its
 * media's available_range at the file's own rate. Pan/Tilt are a fraction of the clip's size fitted into the frame,
 * + Tilt moving the picture up. A reframed shot's moving window (Item.path) is Pan keyed by frame from the clip's first
 * (`Key Frames`: { "<frame>": { Value, Variant Type } }, as Resolve writes Dynamic Zoom's), eased by keys every frame it
 * moves (framing.ts panKeys), since Resolve eases linearly between keys and its own curve handles are not written.
 * `target_url` is the file's path as given: an absolute path on this machine, or relative
 * to the timeline file in a zip (bare paths are what Resolve itself writes; a file:// URL is not needed).
 * A planned shot's moves (punch, zoom, shake, a whip) are keyed the same way on Zoom, Pan and Tilt, the window's pan and
 * the moves' summed into one set of keys (carry.ts motion).
 */

/**
 * The OTIO as the file's text. Times and effect values are written with a decimal point, as Resolve writes them:
 * Resolve 21.2 refuses a whole file whose effect values are whole numbers ("1" where it writes "1.0"), its markers too.
 */
export const otioText = (o: object): string =>
  JSON.stringify(o, null, 2).replace(/("(?:rate|value|Value|Default Parameter Value|Parameter Value|maxValue|minValue)": -?\d+)(?=[,\n])/g, "$1.0");

const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const range = (start: number, dur: number, rate: number) => ({ OTIO_SCHEMA: "TimeRange.1", duration: rt(dur, rate), start_time: rt(start, rate) });
const param = (id: string, value: number, def: number, lo: number, hi: number, keys: { f: number; v: number }[] = []) => ({
  "Default Parameter Value": def,
  "Key Frames": Object.fromEntries(keys.map((k) => [String(k.f), { Value: k.v, "Variant Type": "Double" }])),
  "Parameter ID": id,
  "Parameter Value": value,
  "Variant Type": "Double",
  maxValue: hi,
  minValue: lo,
});
const effect = (name: string, type: number, params: object[], display = name) => ({
  OTIO_SCHEMA: "Effect.1",
  name: "",
  effect_name: "Resolve Effect",
  metadata: { Resolve_OTIO: { "Display Type": 1, "Effect Name": name, Enabled: true, Name: display, Parameters: params, Type: type } },
});

function clip(tl: Timeline, i: Item, src: TimelineSource, file: string, video: boolean, linkIds: Map<string, number>, grade?: Cdl) {
  const effects: object[] = [];
  const meta: Record<string, unknown> = {};
  // the shot's window and moves (carry.ts motion): Pan a share of the fitted picture's width, Tilt of its height
  const keys = video ? motion(tl, i) : [];
  if (keys.length > 1 || (keys[0] && (keys[0].zoom !== 1 || keys[0].x || keys[0].y))) {
    const { w, h } = fitted(src, tl.width, tl.height);
    // each value at the first key, and keyed only when it changes
    const keyed = (id: string, v: (k: (typeof keys)[number]) => number, def: number, lo: number, hi: number) => {
      const ks = keys.map((k) => ({ f: k.f, v: v(k) }));
      return param(id, ks[0]!.v, def, lo, hi, ks.some((k) => k.v !== ks[0]!.v) ? ks : []);
    };
    effects.push(
      effect("Transform", 2, [
        keyed("transformationZoomX", (k) => k.zoom, 1, 0, 100),
        keyed("transformationZoomY", (k) => k.zoom, 1, 0, 100),
        keyed("transformationPan", (k) => Math.round((k.x / w) * 1e5) / 1e5, 0, -4, 4),
        keyed("transformationTilt", (k) => k.y / h, 0, -4, 4),
      ]),
    );
  }
  if (!video) {
    // ponytail: two channels, as a stereo camera file; read the channel count from the probe when a mono file imports wrong
    meta.Channels = [0, 1].map((c) => ({ "Source Channel ID": c, "Source Track ID": 0 }));
    if (i.gainDb) effects.push(effect("Fairlight Clip Volume and Fades", 62, [param("volume", i.gainDb, 0, -100, 30)], "Volume"));
  }
  // a planned shot's speed (a ramp as its mean: the cuts stay where they are; the ramp itself is in the shot's marker)
  const speed = meanSpeed(i, tl.fps);
  if (speed !== 1) effects.push({ OTIO_SCHEMA: "LinearTimeWarp.1", name: "", effect_name: "LinearTimeWarp", metadata: {}, time_scalar: speed });
  // the grade is metadata for Resolve to apply on node 1 (the same values SetCDL takes); the picture is not changed here
  if (video && grade) meta.CDL = cdlMeta(grade);
  if (i.link) {
    if (!linkIds.has(i.link)) linkIds.set(i.link, linkIds.size + 1);
    meta["Link Group ID"] = linkIds.get(i.link);
  }
  return {
    OTIO_SCHEMA: "Clip.2",
    metadata: { Resolve_OTIO: meta },
    name: src.name,
    source_range: range(Math.round(((src.tc + i.in) * tl.fps) / src.fps), i.len, tl.fps),
    effects,
    markers: [],
    enabled: true,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        metadata: {},
        name: path.basename(file),
        available_range: range(src.tc, src.dur, src.fps),
        available_image_bounds: null,
        target_url: file,
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
  };
}

const gap = (frames: number, fps: number) => ({ OTIO_SCHEMA: "Gap.1", metadata: {}, name: "", source_range: range(0, frames, fps), effects: [], markers: [], enabled: true });

/**
 * The draft as an OTIO object (JSON.stringify it to a .otio file); `files` maps each source key to its media path.
 * `grade` (optional) puts the CDL on each V1 clip, as the preview grades V1; no grade = no CDL metadata.
 */
export function toOtio(tl: Timeline, files: Record<string, string>, grade?: Cdl): object {
  const linkIds = new Map<string, number>();
  const tracks = TRACKS.map((id) => {
    const video = id.startsWith("V");
    const children: object[] = [];
    let at = 0;
    for (const i of [...tl.tracks[id].items].sort((a, b) => a.rec - b.rec)) {
      if (i.rec < at) throw new Error(`${id}: the clip at ${i.rec} overlaps the one before`);
      if (i.rec > at) children.push(gap(i.rec - at, tl.fps));
      if (video && i.enter === "dissolve") {
        // a cross dissolve centred on the cut (OTIO's own transition; the first shot's fades in from black)
        // ponytail: OTIO's documented Transition.1, not yet checked in Resolve
        const d = dissolveFrames(tl, i);
        const half = i.rec ? Math.floor(d / 2) : 0;
        children.push({ OTIO_SCHEMA: "Transition.1", metadata: {}, name: "Cross Dissolve", transition_type: "SMPTE_Dissolve", in_offset: rt(half, tl.fps), out_offset: rt(d - half, tl.fps) });
      }
      const src = tl.sources[i.src];
      const file = files[i.src];
      if (!src || !file) throw new Error(`${id}: no media for ${i.src}`);
      // a take with no picture (a voice recording) is sound only: its place on the video track is a gap, its voice is on A1
      children.push(video && !src.w ? gap(i.len, tl.fps) : clip(tl, i, src, file, video, linkIds, id === "V1" ? grade : undefined));
      at = i.rec + i.len;
    }
    return {
      OTIO_SCHEMA: "Track.1",
      name: tl.tracks[id].name,
      kind: video ? "Video" : "Audio",
      enabled: true,
      metadata: { Resolve_OTIO: video ? { Locked: false } : { Locked: false, "Audio Type": "Stereo", SoloOn: false } },
      source_range: null,
      effects: [],
      markers: [],
      children,
    };
  });
  const markers = tl.markers.map((m) => ({
    OTIO_SCHEMA: "Marker.2",
    name: m.name,
    color: m.color,
    metadata: { Resolve_OTIO: { Keywords: [], Note: m.note } },
    marked_range: range(m.rec, 1, tl.fps),
  }));
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: tl.name,
    global_start_time: rt(3600 * Math.round(tl.fps), tl.fps),
    metadata: { Resolve_OTIO: { "Resolve OTIO Meta Version": "1.0" } },
    tracks: { OTIO_SCHEMA: "Stack.1", name: "", metadata: {}, source_range: null, effects: [], markers, children: tracks },
  };
}
