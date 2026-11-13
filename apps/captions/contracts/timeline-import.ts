/**
 * A timeline file from an editing app, as the Review timeline under the player
 * (Anyone uploading a cut can add its timeline, not only AI
 * Editor drafts). OTIO (Resolve), FCP7 XML (Premiere, Resolve), FCPXML (Final
 * Cut, Resolve) and CMX3600 EDL (every app). Positions are frames from the
 * timeline's first frame, so they line up with a render of the whole timeline.
 * The view has clip names only, never paths (share-link reviewers see it): each
 * file is a key (`src`, "s1", "s2"...) with where the item starts in it (`ins`)
 * and its media room; timelineSources gives the keys' paths, for managers.
 * api/review.ts keeps the file as sent and reads it on each GET (an EDL needs
 * the video's frame rate, known once processed).
 */

import type { TimelineItem, TimelineView } from "./edit-timeline";

// the view this parser fills (a subset: no framing or grades), the one Review's timeline draws
export type { TimelineItem, TimelineView };

export const TIMELINE_ACCEPT = ".otio,.xml,.fcpxml,.edl";
export const isTimelineFile = (name: string) => /\.(otio|xml|fcpxml|edl)$/i.test(name);
/** Resolve's FCP7 XML of a 90 s reel with 8 tracks is 0.66 MB, its OTIO 2 MB. */
export const MAX_TIMELINE_BYTES = 30 * 1024 * 1024;
/** Review's comment anchors name V1-V9 / A1-A9. */
const MAX_TRACKS = 9;
const MAX_ITEMS = 5000;

export class TimelineError extends Error {}

/** `path` = the source file as the timeline names it; `ins` = seconds into it; `before`/`after` = its frames past each end. */
type Clip = { rec: number; len: number; label: string; detail?: string; path?: string; ins?: number; before?: number; after?: number };
type Lane = { kind: "V" | "A"; name: string; clips: Clip[] };
type Parsed = {
  name: string;
  fps: number;
  width?: number;
  height?: number;
  lanes: Lane[];
  markers: TimelineView["markers"];
};

/** `fps` = the video's, for an EDL (EDLs don't say theirs). */
export const importTimeline = (fileName: string, text: string, fps?: number): TimelineView => read(fileName, text, fps).view;

/** The source files of importTimeline's view: { [src]: absolute path } (managers only: paths are private). */
export const timelineSources = (fileName: string, text: string, fps?: number): Record<string, string> =>
  read(fileName, text, fps).sources;

function read(fileName: string, text: string, fps?: number) {
  const head = text.slice(0, 4000);
  const parsed = /^\s*\{/.test(head) ? otio(text)
    : /<fcpxml[\s>]/.test(head) ? fcpxml(xml(text))
    : /<xmeml[\s>]/.test(head) ? fcp7(xml(text))
    : /^\s*\d{1,6}\s+\S+\s+\S+\s+.*\d\d:\d\d:\d\d[:;.]\d\d/m.test(head) ? edl(text, fps)
    : null;
  if (!parsed) {
    throw new TimelineError(`${fileName} isn't a timeline: export OTIO, FCP 7 XML, FCPXML or EDL from your editor`);
  }
  return finish(parsed, fileName);
}

/** Tracks as Review draws them (V3 V2 V1, then A1 A2), clips in order, no overlaps per key. */
function finish(p: Parsed, fileName: string): { view: TimelineView; sources: Record<string, string> } {
  if (!(p.fps >= 1 && p.fps <= 240)) throw new TimelineError(`${fileName}: no frame rate in the file`);
  const tracks: TimelineView["tracks"] = [];
  const keys = new Map<string, string>(); // path -> "s1", in order of first use
  const keyOf = (path: string) => keys.get(path) ?? keys.set(path, `s${keys.size + 1}`).get(path)!;
  const whole = (n: number | undefined) => (n !== undefined && Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined);
  let total = 0;
  for (const kind of ["V", "A"] as const) {
    let n = 0;
    for (const lane of p.lanes.filter((l) => l.kind === kind)) {
      const seen = new Set<number>();
      const clips = lane.clips
        .filter((c) => c.len > 0 && c.rec >= 0 && !seen.has(c.rec) && seen.add(c.rec))
        .sort((a, b) => a.rec - b.rec);
      if (!clips.length || n === MAX_TRACKS) continue;
      const id = `${kind}${++n}`;
      const items = clips.slice(0, MAX_ITEMS - total).map((c): TimelineItem => ({
        key: `${id}:${c.rec}`, track: id, rec: c.rec, len: c.len,
        label: c.label.slice(0, 120) || "clip",
        ...(c.detail ? { detail: c.detail.slice(0, 200) } : {}),
        ...(c.path ? { src: keyOf(c.path) } : {}),
        ...(c.ins !== undefined && Number.isFinite(c.ins) && c.ins >= 0 ? { ins: Math.round(c.ins * 1000) / 1000 } : {}),
        ...(whole(c.before) !== undefined ? { before: whole(c.before) } : {}),
        ...(whole(c.after) !== undefined ? { after: whole(c.after) } : {}),
      }));
      total += items.length;
      tracks.push({ id, name: lane.name.slice(0, 40), items });
    }
  }
  if (!tracks.length) throw new TimelineError(`${fileName}: no clips on its timeline`);
  const v = tracks.filter((t) => t.id[0] === "V").reverse();
  const duration = Math.max(...tracks.flatMap((t) => t.items.map((i) => i.rec + i.len)));
  const view: TimelineView = {
    name: (p.name || fileName.replace(/\.[^.]+$/, "")).slice(0, 160),
    fps: p.fps,
    duration,
    width: p.width ?? 0,
    height: p.height ?? 0,
    tracks: [...v, ...tracks.filter((t) => t.id[0] === "A")],
    markers: p.markers
      .filter((m) => m.frame >= 0 && m.frame <= duration)
      .slice(0, 500)
      .map((m) => ({ frame: m.frame, name: m.name.slice(0, 80), ...(m.color ? { color: m.color } : {}) })),
    words: [],
    flags: [],
  };
  return { view, sources: Object.fromEntries([...keys].map(([path, key]) => [key, path])) };
}

const fps3 = (f: number) => Math.round(f * 1000) / 1000;
const baseName = (p: string) => decodeURIComponent(p.split(/[/\\]/).pop() ?? p);
/**
 * A source file as an absolute path: file:// URLs decoded (file://localhost/ too), Windows' backslashes as slashes.
 * Relative paths (a package's media/clip.mov) and anything else give nothing: there's no file to play there.
 */
export function filePath(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  let p = v.trim();
  if (/^file:/i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:(\/\/(localhost)?)?/i, ""));
    } catch {
      return undefined;
    }
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///C:/x
  }
  p = p.replace(/\\/g, "/");
  return /^(\/|[A-Za-z]:\/)/.test(p) && !p.endsWith("/") ? p : undefined;
}
/** Source timecode for the hover text. */
function tc(frames: number, fps: number) {
  const tb = Math.round(fps) || 25;
  const f = Math.max(0, Math.round(frames));
  const s = Math.floor(f / tb);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(f % tb)}`;
}
/** "Red" from Resolve's and OTIO's colour names (EditTimeline's MARKER_COLOR). */
const color = (c: unknown) =>
  typeof c === "string" && c ? (c === "MAGENTA" ? "Lavender" : c[0].toUpperCase() + c.slice(1).toLowerCase()) : undefined;

// ---------- OTIO (JSON) ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = Record<string, any>;
const secs = (rt: J | undefined) => (rt && rt.rate ? Number(rt.value) / Number(rt.rate) : NaN);

function otio(text: string): Parsed {
  let j: J;
  try {
    j = JSON.parse(text);
  } catch {
    throw new TimelineError("This OTIO file isn't valid JSON");
  }
  if (String(j.OTIO_SCHEMA).startsWith("SerializableCollection")) {
    j = (j.children ?? []).find((c: J) => String(c?.OTIO_SCHEMA).startsWith("Timeline")) ?? {};
  }
  if (!String(j.OTIO_SCHEMA).startsWith("Timeline")) throw new TimelineError("No timeline in this OTIO file");
  const stack: J = j.tracks ?? {};
  const firstClip = (t: J): J | undefined => t?.children?.find((c: J) => c?.source_range);
  const fps = fps3(Number(j.global_start_time?.rate) || Number(firstClip(stack.children?.[0] ?? {})?.source_range?.duration?.rate) || 0);
  const ref = (c: J): J => c.media_references?.[c.active_media_reference_key] ?? c.media_reference ?? {};
  // a nested stack or track without a range lasts as long as what's in it
  const length = (c: J): number => {
    const d = secs((c.source_range ?? ref(c).available_range)?.duration);
    if (d > 0) return d;
    const parts = ((c.children ?? []) as J[]).filter((x) => !String(x?.OTIO_SCHEMA).startsWith("Transition")).map(length);
    return String(c.OTIO_SCHEMA).startsWith("Stack") ? Math.max(0, ...parts) : parts.reduce((a, b) => a + b, 0);
  };
  const lanes: Lane[] = (stack.children ?? [])
    .filter((t: J) => String(t?.OTIO_SCHEMA).startsWith("Track"))
    .map((t: J): Lane => {
      let at = 0; // seconds: no drift from rounding each clip
      const clips: Clip[] = [];
      for (const c of t.children ?? []) {
        const schema = String(c?.OTIO_SCHEMA);
        if (schema.startsWith("Transition")) continue; // overlaps its neighbours, takes no time
        const range = c.source_range ?? ref(c).available_range;
        const dur = length(c);
        if (!(dur > 0)) continue;
        if (!schema.startsWith("Gap")) {
          const r = ref(c);
          const name = c.name || r.name || baseName(String(r.target_url ?? r.target_url_base ?? ""));
          const start = secs(range?.start_time);
          // seconds into the file: from its own first frame (a file whose range the reference doesn't say starts at 0)
          const media = r.available_range;
          const first = secs(media?.start_time);
          const ins = start - (Number.isFinite(first) ? first : 0);
          const length = secs(media?.duration);
          clips.push({
            rec: Math.round(at * fps), len: Math.round(dur * fps), label: String(name),
            detail: [Number.isFinite(start) && `source ${tc(start * fps, fps)}`, c.enabled === false && "disabled"]
              .filter(Boolean).join(" · "),
            path: String(r.OTIO_SCHEMA).startsWith("ExternalReference") ? filePath(r.target_url) : undefined,
            ...(Number.isFinite(ins) ? { ins } : {}),
            ...(length > 0 && Number.isFinite(ins) ? { before: ins * fps, after: (length - ins - dur) * fps } : {}),
          });
        }
        at += dur;
      }
      return { kind: t.kind === "Audio" ? "A" : "V", name: String(t.name ?? ""), clips };
    });
  return {
    name: String(j.name ?? ""),
    fps,
    lanes,
    markers: (stack.markers ?? []).map((m: J) => ({
      frame: Math.round(secs(m.marked_range?.start_time) * fps), name: String(m.name ?? ""), color: color(m.color),
    })),
  };
}

// ---------- XML (the timeline exports are machine-written: elements, attributes, text) ----------

export type X = { tag: string; attrs: Record<string, string>; kids: X[]; text: string };

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITY[e] ?? m;
    const cp = Number(/x/i.test(e) ? `0${e.slice(1)}` : e.slice(1));
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });

export function xml(s: string): X {
  const root: X = { tag: "", attrs: {}, kids: [], text: "" };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of s.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const i = stack.map((x) => x.tag).lastIndexOf(m[2]);
      if (i > 0) stack.length = i;
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el: X = { tag: m[3], attrs, kids: [], text: "" };
      top.kids.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += decode(m[6]);
  }
  return root;
}

const kid = (x: X | undefined, tag: string) => x?.kids.find((k) => k.tag === tag);
const kids = (x: X | undefined, tag: string) => x?.kids.filter((k) => k.tag === tag) ?? [];
const text = (x: X | undefined) => x?.text.trim() ?? "";
/** The first element `tag` under x, depth first, not looking inside `skip`. */
function find(x: X, tag: string, skip?: string): X | undefined {
  for (const k of x.kids) {
    if (k.tag === tag) return k;
    if (k.tag === skip) continue;
    const f = find(k, tag, skip);
    if (f) return f;
  }
}

// ---------- FCPXML (Final Cut Pro X, Resolve) ----------
// Times are rational seconds ("1001/30000s"). Every element maps its own time
// to its parent's: parent = offset + (t - start). The primary storyline is
// lane 0; connected clips (lane n) hang off a clip in their parent's time;
// a secondary storyline (spine with a lane) runs its clips in order.

const CLIPS = new Set(["asset-clip", "clip", "ref-clip", "sync-clip", "mc-clip", "title", "video", "audio"]);

export function rational(v: string | undefined): number {
  if (!v) return 0;
  const m = /^(-?\d+(?:\.\d+)?)(?:\/(\d+))?s$/.exec(v.trim());
  return m ? Number(m[1]) / (m[2] ? Number(m[2]) : 1) : 0;
}

function fcpxml(root: X): Parsed {
  const doc = find(root, "fcpxml")!;
  const res = new Map<string, X>();
  for (const r of kid(doc, "resources")?.kids ?? []) if (r.attrs.id) res.set(r.attrs.id, r);
  // a compound clip's sequence sits in <resources>: the project's is the timeline
  const project = find(doc, "project", "resources");
  const seq = kid(project, "sequence") ?? find(doc, "sequence", "resources");
  const spine = kid(seq, "spine");
  if (!seq || !spine) throw new TimelineError("No sequence in this FCPXML: export a project, not a library or event");
  const fmt = res.get(seq.attrs.format);
  const frame = rational(fmt?.attrs.frameDuration);
  const fps = frame > 0 ? fps3(1 / frame) : 0;
  const t0 = rational(seq.attrs.tcStart);
  const byLane = new Map<string, Lane & { lane: number }>();
  const markers: TimelineView["markers"] = [];

  const kindOf = (el: X): "V" | "A" => {
    if (el.tag === "audio") return "A";
    // Resolve leaves hasVideo off an audio file's asset
    if (el.tag === "asset-clip") return res.get(el.attrs.ref)?.attrs.hasVideo === "1" ? "V" : "A";
    if (el.tag === "clip") return kid(el, "video") || !kid(el, "audio") ? "V" : "A";
    return "V";
  };
  /** The file an element plays, and its start there (seconds into the file): an asset-clip or a lane's video/audio
   *  names its asset; Resolve's clip wraps a video or audio that does, in the clip's own time. */
  const mediaOf = (el: X, start: number): { asset?: X; at: number } => {
    if (el.tag === "asset-clip" || el.tag === "video" || el.tag === "audio") return { asset: res.get(el.attrs.ref), at: start };
    const inner = el.tag === "clip" ? [kid(el, "video"), kid(el, "audio")].find((k) => k?.attrs.ref) : undefined;
    return inner
      ? { asset: res.get(inner.attrs.ref), at: rational(inner.attrs.start) + start - rational(inner.attrs.offset) }
      : { at: start };
  };
  const put = (el: X, lane: number, rec: number, len: number, start: number) => {
    const kind = kindOf(el);
    const key = `${kind}${lane}`;
    if (!byLane.has(key)) {
      byLane.set(key, {
        kind, lane, clips: [],
        name: lane === 0 ? "Primary storyline" : kind === "A" ? el.attrs.audioRole?.split(".")[0] ?? "" : "",
      });
    }
    const name = el.attrs.name || res.get(el.attrs.ref)?.attrs.name || el.tag;
    const { asset, at } = mediaOf(el, start);
    const reps = kids(asset, "media-rep");
    const ins = at - rational(asset?.attrs.start);
    const length = rational(asset?.attrs.duration);
    byLane.get(key)!.clips.push({
      rec, len, label: name,
      detail: [`source ${tc(start * fps, fps)}`, el.attrs.enabled === "0" && "disabled"].filter(Boolean).join(" · "),
      ...(asset ? {
        path: filePath((reps.find((r) => r.attrs.kind === "original-media") ?? reps[0])?.attrs.src ?? asset.attrs.src),
        ins,
        before: ins * fps,
        ...(length > 0 ? { after: (length - ins) * fps - len } : {}),
      } : {}),
    });
  };
  /** `map`: this container's time -> timeline seconds. In a spine every child is on the spine's lane; in a clip only children with a lane are (the rest is the clip's own media). */
  const walk = (box: X, map: (t: number) => number, lane: number, inSpine: boolean) => {
    for (let el of box.kids) {
      if (el.tag === "audition") el = el.kids.find((k) => CLIPS.has(k.tag)) ?? el;
      const own = inSpine ? lane : el.attrs.lane !== undefined ? lane + Number(el.attrs.lane) : null;
      if (own === null || !Number.isFinite(own)) {
        if (el.tag === "marker" || el.tag === "chapter-marker") {
          markers.push({ frame: Math.round(map(rational(el.attrs.start)) * fps), name: el.attrs.value ?? "" });
        }
        continue;
      }
      const offset = rational(el.attrs.offset);
      const start = rational(el.attrs.start);
      const inner = (t: number) => map(offset + t - start);
      if (el.tag === "spine") walk(el, inner, own, true);
      else if (el.tag === "gap") walk(el, inner, own, false);
      else if (CLIPS.has(el.tag)) {
        put(el, own, Math.round(map(offset) * fps), Math.round(rational(el.attrs.duration) * fps), start);
        walk(el, inner, own, false);
      }
    }
  };
  walk(spine, (t) => t - t0, 0, true);
  // lanes above the storyline are video tracks bottom up; audio lanes (below in Final Cut, above in Resolve) nearest first
  const lanes = [...byLane.values()].sort((a, b) => (a.kind === "V" ? a.lane - b.lane : Math.abs(a.lane) - Math.abs(b.lane)));
  return {
    name: project?.attrs.name ?? "",
    fps,
    width: Number(fmt?.attrs.width) || undefined,
    height: Number(fmt?.attrs.height) || undefined,
    lanes,
    markers,
  };
}

// ---------- FCP 7 XML / xmeml (Premiere, Resolve, Avid) ----------
// start/end are frames from the sequence's first frame (-1 = inside a
// transition: then the clip's own in/out gives the length).

function fcp7(root: X): Parsed {
  const seq = find(root, "sequence", "clipitem");
  if (!seq) throw new TimelineError("No sequence in this XML");
  const rateOf = (x: X | undefined) => {
    const r = kid(x, "rate");
    const tb = Number(text(kid(r, "timebase")));
    return tb > 0 ? fps3(text(kid(r, "ntsc")).toUpperCase() === "TRUE" ? (tb * 1000) / 1001 : tb) : 0;
  };
  const fps = rateOf(seq);
  const media = kid(seq, "media");
  const sc = kid(kid(kid(media, "video"), "format"), "samplecharacteristics");
  const num = (x: X | undefined, tag: string) => Number(text(kid(x, tag)) || NaN);
  const files = new Map<string, X>();
  const lane = (kind: "V" | "A") => (track: X): Lane => ({
    kind,
    name: "",
    clips: [...kids(track, "clipitem"), ...kids(track, "generatoritem")].flatMap((ci): Clip[] => {
      const inn = num(ci, "in");
      const out = num(ci, "out");
      let start = num(ci, "start");
      let end = num(ci, "end");
      if (start < 0 && end >= 0) start = end - (out - inn);
      if (end < 0 && start >= 0) end = start + (out - inn);
      if (!(end > start)) return [];
      const file = kid(ci, "file");
      if (file?.attrs.id && file.kids.length) files.set(file.attrs.id, file);
      const f = file?.attrs.id ? files.get(file.attrs.id) ?? file : file;
      const fileTc = text(kid(kid(f, "timecode"), "string"));
      const srcFps = rateOf(ci) || fps;
      const src = (/^\d+:\d+:\d+[:;]\d+$/.test(fileTc) ? tcFrames(fileTc, srcFps) : 0) + (inn >= 0 ? inn : 0);
      // in/out are the clip's frames from its file's first frame; the file's length is its duration
      const length = num(f, "duration") || num(ci, "duration");
      return [{
        rec: start, len: end - start,
        label: text(kid(ci, "name")) || text(kid(f, "name")) || "clip",
        detail: [`source ${tc(src, srcFps)}`, text(kid(ci, "enabled")).toUpperCase() === "FALSE" && "disabled"]
          .filter(Boolean).join(" · "),
        path: filePath(text(kid(f, "pathurl"))),
        ...(inn >= 0 ? { ins: inn / srcFps, before: (inn / srcFps) * fps } : {}),
        ...(inn >= 0 && length > 0 ? { after: ((length - out) / srcFps) * fps } : {}),
      }];
    }),
  });
  let lanes = [...kids(kid(media, "video"), "track").map(lane("V")), ...kids(kid(media, "audio"), "track").map(lane("A"))];
  let markers = kids(seq, "marker").map((m) => ({ frame: num(m, "in"), name: text(kid(m, "name")) || text(kid(m, "comment")) }));
  // In/Out marked on the sequence: Premiere renders that range by default
  const inn = num(seq, "in");
  const out = num(seq, "out");
  if (inn >= 0 && out > inn) {
    lanes = lanes.map((l) => ({
      ...l,
      clips: l.clips.flatMap((c) => {
        const a = Math.max(c.rec, inn);
        const b = Math.min(c.rec + c.len, out);
        // what the range cuts off a clip is media past its ends now
        return b > a ? [{
          ...c, rec: a - inn, len: b - a,
          ...(c.ins !== undefined ? { ins: c.ins + (a - c.rec) / fps } : {}),
          ...(c.before !== undefined ? { before: c.before + a - c.rec } : {}),
          ...(c.after !== undefined ? { after: c.after + c.rec + c.len - b } : {}),
        }] : [];
      }),
    }));
    markers = markers.map((m) => ({ ...m, frame: m.frame - inn }));
  }
  return {
    name: text(kid(seq, "name")),
    fps,
    width: num(sc, "width") || undefined,
    height: num(sc, "height") || undefined,
    lanes,
    markers,
  };
}

// ---------- CMX3600 EDL ----------

/** "01:00:05:23" (or ";" drop frame at 29.97/59.94) -> frames at fps. */
export function tcFrames(s: string, fps: number): number {
  const [h, m, sec, f] = s.split(/[:;.]/).map(Number);
  const tb = Math.round(fps);
  const frames = ((h * 60 + m) * 60 + sec) * tb + f;
  if (!s.includes(";") || tb === fps) return frames;
  const drop = Math.round(tb / 15); // 2 at 29.97, 4 at 59.94
  const minutes = h * 60 + m;
  return frames - drop * (minutes - Math.floor(minutes / 10));
}

function edl(text: string, hint?: number): Parsed {
  const events: { track: string; src: string; rin: string; rout: string; name: string; path?: string }[] = [];
  let title = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const t = /^TITLE:\s*(.*)$/i.exec(line);
    if (t) title = t[1].trim();
    const name = /^\*\s*FROM CLIP NAME:\s*(.*)$/i.exec(line);
    if (name && events.length) events[events.length - 1].name = name[1].trim();
    // the file, where the editor wrote it: "* SOURCE FILE: /path", "* FROM CLIP: /path" (or a path as the clip name)
    const file = /^\*\s*(?:SOURCE FILE|FROM CLIP(?: NAME)?):\s*(.*)$/i.exec(line);
    const path = file && filePath(file[1]);
    if (path && events.length) events[events.length - 1].path = path;
    const tok = line.split(/\s+/);
    const tcs = tok.filter((x) => /^\d\d:\d\d:\d\d[:;.]\d\d$/.test(x));
    if (/^\d{1,6}$/.test(tok[0]) && tcs.length === 4) {
      events.push({ track: tok[2], src: tcs[0], rin: tcs[2], rout: tcs[3], name: tok[1] });
    }
  }
  if (!events.length) throw new TimelineError("No events in this EDL");
  // an EDL doesn't say its frame rate: the video's, else the smallest that fits every frame number
  const top = Math.max(...events.flatMap((e) => [e.src, e.rin, e.rout].map((s) => Number(s.slice(-2)))));
  const fps = hint && hint >= 1 ? hint : [24, 25, 30, 50, 60].find((f) => f > top) ?? 60;
  const first = Math.min(...events.map((e) => tcFrames(e.rin, fps)));
  const hour = Math.round(fps) * 3600;
  const zero = Math.floor(first / hour) * hour; // the timeline starts on the hour (00:00:00:00 or 01:00:00:00)
  const lanes = new Map<string, Lane>();
  // an event without a file comment plays the file another event of the same clip names
  const named = new Map(events.filter((e) => e.path).map((e) => [e.name, e.path!]));
  for (const e of events) {
    const id = /V/i.test(e.track) ? "V1" : `A${/\d+/.exec(e.track)?.[0] ?? 1}`;
    if (!lanes.has(id)) lanes.set(id, { kind: id[0] as "V" | "A", name: "", clips: [] });
    const rec = tcFrames(e.rin, fps) - zero;
    const path = e.path ?? named.get(e.name);
    // ponytail: an EDL doesn't say where its file's timecode starts: taken as 00:00:00:00 (a file that starts later
    // plays silent from here, past its end); the file's first timecode from the file itself if that matters
    lanes.get(id)!.clips.push({
      rec, len: tcFrames(e.rout, fps) - zero - rec, label: e.name, detail: `source ${e.src}`,
      ...(path ? { path, ins: tcFrames(e.src, fps) / fps } : {}),
    });
  }
  return {
    name: title,
    fps: fps3(fps),
    lanes: [...lanes.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([, l]) => l),
    markers: [],
  };
}
