import path from "node:path";
import { TRACKS, type Item, type Timeline, type TimelineSource } from "../../contracts/editor";
import { type Cdl, cdlMeta } from "./grade";
import { fitted } from "./framing";

/**
 * A draft as OpenTimelineIO JSON, written by hand (no package). Clips carry the metadata DaVinci Resolve reads on
 * import (`Resolve_OTIO`: transform, clip volume, link groups, marker notes); other readers ignore it.
 *
 * Units: a clip's source_range is in the file's timecode frames at the timeline rate (start timecode + `in`), its
 * media's available_range at the file's own rate. Pan/Tilt are a fraction of the clip's size fitted into the frame,
 * + Tilt moving the picture up. `target_url` is the file's path as given: an absolute path on this machine, or relative
 * to the timeline file in a zip (bare paths are what Resolve itself writes; a file:// URL is not needed).
 */

const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const range = (start: number, dur: number, rate: number) => ({ OTIO_SCHEMA: "TimeRange.1", duration: rt(dur, rate), start_time: rt(start, rate) });
const param = (id: string, value: number, def: number, lo: number, hi: number) => ({
  "Default Parameter Value": def,
  "Key Frames": {},
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
  if (video && ((i.zoom ?? 1) !== 1 || i.tilt)) {
    const { h } = fitted(src, tl.width, tl.height);
    const zoom = i.zoom ?? 1;
    effects.push(
      effect("Transform", 2, [
        param("transformationZoomX", zoom, 1, 0, 100),
        param("transformationZoomY", zoom, 1, 0, 100),
        param("transformationPan", 0, 0, -4, 4) /* pan stays 0 */,
        param("transformationTilt", (i.tilt ?? 0) / h, 0, -4, 4),
      ]),
    );
  }
  if (!video) {
    // ponytail: two channels, as a stereo camera file; read the channel count from the probe when a mono file imports wrong
    meta.Channels = [0, 1].map((c) => ({ "Source Channel ID": c, "Source Track ID": 0 }));
    if (i.gainDb) effects.push(effect("Fairlight Clip Volume and Fades", 62, [param("volume", i.gainDb, 0, -100, 30)], "Volume"));
  }
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
