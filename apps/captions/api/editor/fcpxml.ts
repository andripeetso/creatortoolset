import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Item, Timeline, TimelineSource } from "../../contracts/editor";
import { motion, retime } from "./carry";
import { fitted } from "./framing";
import { meanSpeed } from "./plan";

/**
 * A draft as FCPXML 1.10 (Final Cut Pro's own exchange format): one asset per source, the speaker track as the spine
 * with each clip's own sound, a marker per line on the clip it falls in. Times are exact rationals: 1001-based for
 * 23.976, 29.97 and 59.94 fps.
 *
 * Checked in Resolve 21.2: each clip lands on its frame from 01:00:00:00 with its source in-point, at 25, 50, 29.97
 * and 59.94 fps; a file that is not at its path is found by name in a folder the import is told to search (with none,
 * a scripted import fails); adjust-transform comes in as Resolve's Zoom and Tilt (scale 1.2 and position "0 5" on a
 * 1080 timeline = Zoom 1.2, Tilt 54 px up). Resolve keeps no marker from an FCPXML in any form (on a clip, a chapter
 * marker, a to-do, version 1.9) and writes none into its own: the lines' markers reach Resolve in the OTIO (otio.ts).
 * Not yet checked: whether a relative media-rep src (in a zip) relinks without asking.
 *
 * A planned shot's moves (punch, zoom, shake, a whip) are keyframes on adjust-transform, its freezes, ramp and
 * reverse a timeMap, a dissolve a Cross Dissolve centred on the cut (carry.ts says what else is left out).
 * ponytail: written from the format's description, not yet checked in Final Cut; check keyframe times on a retimed clip first
 */

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** A frame's duration as [num, den] seconds: 1001/30000 for 29.97, 1/25 for 25. */
export function frameDuration(fps: number): [number, number] {
  const ntsc = Math.round(fps * 1.001);
  if (Math.abs(fps - (ntsc * 1000) / 1001) < 0.01 && Math.abs(fps - Math.round(fps)) > 0.001) return [1001, ntsc * 1000];
  if (Number.isInteger(fps)) return [1, fps];
  return [1000, Math.round(fps * 1000)];
}

/** `frames` at `fps` as an FCPXML time: "0s", "2s", "1001/500s". */
export function time(frames: number, fps: number): string {
  const [n, d] = frameDuration(fps);
  const num = frames * n;
  if (!num) return "0s";
  const g = gcd(Math.abs(num), d);
  return d / g === 1 ? `${num / g}s` : `${num / g}/${d / g}s`;
}

const pct = (px: number, of: number) => Math.round((px / of) * 100 * 1000) / 1000;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** An absolute path as a file URL; a relative one (a zip's media/) as a relative URL. */
const url = (file: string) => (path.isAbsolute(file) ? pathToFileURL(file).href : file.split("/").map(encodeURIComponent).join("/"));

/** The draft as an FCPXML document; `files` maps each source key to its media path. */
export function toFcpxml(tl: Timeline, files: Record<string, string>): string {
  const ids = new Map<string, { asset: string; format: string }>();
  const res: string[] = [`    <format id="r1" frameDuration="${time(1, tl.fps)}" width="${tl.width}" height="${tl.height}"/>`];
  const used = [...new Set(tl.tracks.V1.items.map((i) => i.src))];
  const dissolves = tl.tracks.V1.items.some((i) => i.enter === "dissolve");
  if (dissolves) res.push(`    <effect id="rx" name="Cross Dissolve" uid="${CROSS_DISSOLVE}"/>`);
  used.forEach((key, k) => {
    const s = tl.sources[key];
    const file = files[key];
    if (!s || !file) throw new Error(`V1: no media for ${key}`);
    const format = `r${2 + 2 * k}`;
    const asset = `r${3 + 2 * k}`;
    ids.set(key, { asset, format });
    res.push(`    <format id="${format}" frameDuration="${time(1, s.fps)}" width="${s.w || tl.width}" height="${s.h || tl.height}"/>`);
    res.push(
      `    <asset id="${asset}" name="${esc(s.name)}" start="${time(s.tc, s.fps)}" duration="${time(s.dur, s.fps)}" hasVideo="${s.w ? 1 : 0}" hasAudio="1" format="${format}" audioSources="1" audioChannels="2" audioRate="48000">`,
      `      <media-rep kind="original-media" src="${esc(url(file))}"/>`,
      `    </asset>`,
    );
  });

  // ponytail: V1 with its own sound only; B-roll, music and effects (V2, A2, A3) become connected clips with the B-roll slice
  // the sequence starts at 01:00:00:00 and a spine's offsets are in its time, so they count from there (as Resolve writes them)
  const t0 = 3600 * Math.round(tl.fps);
  const spine: string[] = [];
  let at = 0;
  const items = [...tl.tracks.V1.items].sort((a, b) => a.rec - b.rec);
  for (const i of items) {
    if (i.rec < at) throw new Error(`V1: the clip at ${i.rec} overlaps the one before`);
    if (i.rec > at) spine.push(`          <gap name="Gap" offset="${time(t0 + at, tl.fps)}" duration="${time(i.rec - at, tl.fps)}"/>`);
    if (i.enter === "dissolve") {
      const d = dissolveFrames(tl, i);
      const half = i.rec ? Math.floor(d / 2) : 0; // the first shot fades in from black, from its first frame
      spine.push(`          <transition name="Cross Dissolve" offset="${time(t0 + i.rec - half, tl.fps)}" duration="${time(d, tl.fps)}">`, `            <filter-video ref="rx" name="Cross Dissolve"/>`, `          </transition>`);
    }
    spine.push(...assetClip(tl, i, tl.sources[i.src]!, ids.get(i.src)!, t0));
    at = i.rec + i.len;
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.10">`,
    `  <resources>`,
    ...res,
    `  </resources>`,
    `  <library>`,
    `    <event name="AI Editor">`,
    `      <project name="${esc(tl.name)}">`,
    `        <sequence format="r1" duration="${time(at, tl.fps)}" tcStart="${time(t0, tl.fps)}" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    `          <spine>`,
    ...spine.map((l) => `  ${l}`),
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
    ``,
  ].join("\n");
}

/** Final Cut's Cross Dissolve, by the id its own files give it. */
const CROSS_DISSOLVE = "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265";
/** A dissolve's length: as the preview's, 0.3 s or half the shot when that is shorter. */
export const dissolveFrames = (tl: Timeline, i: Item) => Math.max(2, Math.round(Math.min(0.3 * tl.fps, i.len / 2)));

function assetClip(tl: Timeline, i: Item, s: TimelineSource, id: { asset: string; format: string }, t0: number): string[] {
  // a clip's start and its markers are in its source's time
  const srcFrames = (rec: number) => s.tc + i.in + Math.round(((rec - i.rec) * s.fps) / tl.fps);
  const inner: string[] = [];
  // a planned shot's freezes, ramp or reverse, point by point; else its speed: source time runs `speed` times as fast
  const map = retime(tl, i);
  const speed = meanSpeed(i, tl.fps);
  if (map) {
    inner.push(`<timeMap>`, ...map.map((p) => `  <timept time="${time(Math.round(p.t * s.fps), s.fps)}" value="${time(Math.round(p.v * s.fps), s.fps)}" interp="linear"/>`), `</timeMap>`);
  } else if (speed !== 1) {
    const d = (i.len * s.fps) / tl.fps;
    inner.push(`<timeMap>`, `  <timept time="0s" value="0s" interp="linear"/>`, `  <timept time="${time(Math.round(d), s.fps)}" value="${time(Math.round(d * speed), s.fps)}" interp="linear"/>`, `</timeMap>`);
  }
  // position is in % of the frame's height, + up and right
  const pos = (k: { x: number; y: number }) => `${pct(k.x, tl.height)} ${pct(k.y, tl.height)}`;
  const keys = motion(tl, i);
  if (keys.length > 1) {
    const anim = (name: string, v: (k: (typeof keys)[number]) => string) => [
      `  <param name="${name}">`,
      `    <keyframeAnimation>`,
      ...keys.map((k) => `      <keyframe time="${time(srcFrames(i.rec + k.f), s.fps)}" value="${v(k)}"/>`),
      `    </keyframeAnimation>`,
      `  </param>`,
    ];
    inner.push(`<adjust-transform>`, ...anim("position", pos), ...anim("scale", (k) => `${k.zoom} ${k.zoom}`), `</adjust-transform>`);
  } else if (keys[0]!.zoom !== 1 || keys[0]!.x || keys[0]!.y) {
    inner.push(`<adjust-transform position="${pos(keys[0]!)}" scale="${keys[0]!.zoom} ${keys[0]!.zoom}"/>`);
  }
  for (const m of tl.markers) {
    if (m.rec < i.rec || m.rec >= i.rec + i.len) continue;
    inner.push(`<marker start="${time(srcFrames(m.rec), s.fps)}" duration="${time(1, s.fps)}" value="${esc(m.name)}" note="${esc(m.note)}"/>`);
  }
  const open = `<asset-clip ref="${id.asset}" name="${esc(s.name)}" offset="${time(t0 + i.rec, tl.fps)}" start="${time(srcFrames(i.rec), s.fps)}" duration="${time(i.len, tl.fps)}" format="${id.format}" tcFormat="NDF"`;
  return inner.length ? [`          ${open}>`, ...inner.map((l) => `            ${l}`), `          </asset-clip>`] : [`          ${open}/>`];
}

const param7 = (id: string, value: string, keys: string[] = []) => `<parameter><parameterid>${id}</parameterid><name>${id}</name><value>${value}</value>${keys.join("")}</parameter>`;
const effect7 = (name: string, id: string, params: string[]) =>
  `<filter><effect><name>${name}</name><effectid>${id}</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${params.join("")}</effect></filter>`;

/** A picture's Basic Motion (framing and moves) and Time Remap (speed, reverse), as FCP 7 XML filters. */
function filters7(tl: Timeline, i: Item, s: TimelineSource, speed: number): string {
  const fit = s.w ? fitted(s, tl.width, tl.height).w / s.w : 1;
  const keys = motion(tl, i);
  const scale = (k: (typeof keys)[number]) => `${Math.round(k.zoom * fit * 100 * 1000) / 1000}`;
  const center = (k: (typeof keys)[number]) => `<horiz>${Math.round((k.x / tl.width) * 1e5) / 1e5}</horiz><vert>${Math.round((-k.y / tl.height) * 1e5) / 1e5}</vert>`;
  const when = (k: (typeof keys)[number]) => i.in + Math.round((k.f * s.fps * speed) / tl.fps);
  const kf = (v: (k: (typeof keys)[number]) => string) => (keys.length > 1 ? keys.map((k) => `<keyframe><when>${when(k)}</when><value>${v(k)}</value></keyframe>`) : []);
  const out: string[] = [];
  if (keys.length > 1 || scale(keys[0]!) !== "100" || keys[0]!.x || keys[0]!.y) {
    out.push(effect7("Basic Motion", "basic", [param7("scale", scale(keys[0]!), kf(scale)), param7("center", center(keys[0]!), kf(center))]));
  }
  const reverse = !!i.fx?.some((f) => f.type === "reverse");
  if (speed !== 1 || reverse) {
    out.push(effect7("Time Remap", "timeremap", [param7("variablespeed", "0"), param7("speed", `${Math.round(speed * 100 * 1000) / 1000}`), param7("reverse", reverse ? "TRUE" : "FALSE"), param7("frameblending", "FALSE")]));
  }
  return out.join("");
}

/** An FCP 7 XML rate: whole timebase, NTSC flag for 23.976, 29.97 and 59.94. */
const rate7 = (fps: number) => `<rate><timebase>${Math.round(fps)}</timebase><ntsc>${Number.isInteger(fps) ? "FALSE" : "TRUE"}</ntsc></rate>`;

/**
 * The draft as FCP 7 XML (xmeml 4), the timeline Premiere Pro opens as a new project: the speaker track (V1) with its
 * own sound on A1, and the lines as sequence markers. Clip in/out are in the source's frames. Each picture's framing
 * and moves are Basic Motion (scale in % of the file's own size, keyframed), its speed and reverse Time Remap.
 * ponytail: no B-roll, music or effects tracks yet; motion and time remap written from the format's description, not
 * yet checked in Premiere (keyframe <when> as source frames, center as a fraction of the frame, + down)
 */
export function toFcp7Xml(tl: Timeline, files: Record<string, string>): string {
  const items = [...tl.tracks.V1.items].sort((a, b) => a.rec - b.rec);
  const written = new Set<string>();
  const t0 = 3600 * Math.round(tl.fps);
  const clip = (i: Item, k: number, kind: "video" | "audio") => {
    const s = tl.sources[i.src];
    const file = files[i.src];
    if (!s || !file) throw new Error(`V1: no media for ${i.src}`);
    const id = `file-${i.src}`;
    // the file in full the first time it is named, by id after that
    const fileXml = written.has(id)
      ? `<file id="${esc(id)}"/>`
      : (written.add(id),
        `<file id="${esc(id)}"><name>${esc(s.name)}</name><pathurl>${esc(url(file))}</pathurl>${rate7(s.fps)}<duration>${s.dur}</duration>` +
          `<timecode>${rate7(s.fps)}<frame>${s.tc}</frame><displayformat>NDF</displayformat></timecode>` +
          `<media>${s.w ? `<video><samplecharacteristics><width>${s.w}</width><height>${s.h}</height></samplecharacteristics></video>` : ""}<audio><channelcount>2</channelcount></audio></media></file>`);
    // the picture runs `speed` times as fast, so it spans that much more of the file; its sound plays as filmed
    const speed = kind === "video" ? meanSpeed(i, tl.fps) : 1;
    const out = i.in + Math.round((i.len * s.fps * speed) / tl.fps);
    return `          <clipitem id="${kind}-${k + 1}"><name>${esc(s.name)}</name><duration>${s.dur}</duration>${rate7(s.fps)}` +
      `<start>${i.rec}</start><end>${i.rec + i.len}</end><in>${i.in}</in><out>${out}</out>${fileXml}` +
      `<sourcetrack><mediatype>${kind}</mediatype>${kind === "audio" ? "<trackindex>1</trackindex>" : ""}</sourcetrack>${kind === "video" ? filters7(tl, i, s, speed) : ""}</clipitem>`;
  };
  // the video items first, so each file's full entry is in the video track
  const video = items.map((i, k) => (tl.sources[i.src]?.w ? clip(i, k, "video") : null)).filter((l): l is string => !!l);
  const audio = items.map((i, k) => clip(i, k, "audio"));
  const end = items.reduce((m, i) => Math.max(m, i.rec + i.len), 0);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="4">`,
    `  <sequence id="sequence-1">`,
    `    <name>${esc(tl.name)}</name>`,
    `    <duration>${end}</duration>`,
    `    ${rate7(tl.fps)}`,
    `    <timecode>${rate7(tl.fps)}<frame>${t0}</frame><displayformat>NDF</displayformat></timecode>`,
    `    <media>`,
    `      <video>`,
    `        <format><samplecharacteristics>${rate7(tl.fps)}<width>${tl.width}</width><height>${tl.height}</height></samplecharacteristics></format>`,
    `        <track>`,
    ...video,
    `        </track>`,
    `      </video>`,
    `      <audio>`,
    `        <track>`,
    ...audio,
    `        </track>`,
    `      </audio>`,
    `    </media>`,
    ...tl.markers.map((m) => `    <marker><name>${esc(m.name)}</name><comment>${esc(m.note)}</comment><in>${m.rec}</in><out>-1</out></marker>`),
    `  </sequence>`,
    `</xmeml>`,
    ``,
  ].join("\n");
}
