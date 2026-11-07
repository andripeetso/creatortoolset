import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Item, Timeline, TimelineSource } from "../../contracts/editor";

/**
 * A draft as FCPXML 1.10 (Final Cut Pro's own exchange format): one asset per source, the speaker track as the spine
 * with each clip's own sound, a marker per line on the clip it falls in. Times are exact rationals: 1001-based for
 * 23.976, 29.97 and 59.94 fps.
 *
 * Not yet checked on import (the owner's manual check): adjust-transform position units (written as percent of the
 * frame height, + up) and whether a relative media-rep src (in a zip) relinks without asking.
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** An absolute path as a file URL; a relative one (a zip's media/) as a relative URL. */
const url = (file: string) => (path.isAbsolute(file) ? pathToFileURL(file).href : file.split("/").map(encodeURIComponent).join("/"));

/** The draft as an FCPXML document; `files` maps each source key to its media path. */
export function toFcpxml(tl: Timeline, files: Record<string, string>): string {
  const ids = new Map<string, { asset: string; format: string }>();
  const res: string[] = [`    <format id="r1" frameDuration="${time(1, tl.fps)}" width="${tl.width}" height="${tl.height}"/>`];
  const used = [...new Set(tl.tracks.V1.items.map((i) => i.src))];
  used.forEach((key, k) => {
    const s = tl.sources[key];
    const file = files[key];
    if (!s || !file) throw new Error(`V1: no media for ${key}`);
    const format = `r${2 + 2 * k}`;
    const asset = `r${3 + 2 * k}`;
    ids.set(key, { asset, format });
    res.push(`    <format id="${format}" frameDuration="${time(1, s.fps)}" width="${s.w}" height="${s.h}"/>`);
    res.push(
      `    <asset id="${asset}" name="${esc(s.name)}" start="${time(s.tc, s.fps)}" duration="${time(s.dur, s.fps)}" hasVideo="${s.w ? 1 : 0}" hasAudio="1" format="${format}" audioSources="1" audioChannels="2" audioRate="48000">`,
      `      <media-rep kind="original-media" src="${esc(url(file))}"/>`,
      `    </asset>`,
    );
  });

  // ponytail: V1 with its own sound only; B-roll, music and effects (V2, A2, A3) become connected clips with the B-roll slice
  const spine: string[] = [];
  let at = 0;
  const items = [...tl.tracks.V1.items].sort((a, b) => a.rec - b.rec);
  for (const i of items) {
    if (i.rec < at) throw new Error(`V1: the clip at ${i.rec} overlaps the one before`);
    if (i.rec > at) spine.push(`          <gap name="Gap" offset="${time(at, tl.fps)}" duration="${time(i.rec - at, tl.fps)}"/>`);
    spine.push(...assetClip(tl, i, tl.sources[i.src]!, ids.get(i.src)!));
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
    `        <sequence format="r1" duration="${time(at, tl.fps)}" tcStart="${time(3600 * Math.round(tl.fps), tl.fps)}" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
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

function assetClip(tl: Timeline, i: Item, s: TimelineSource, id: { asset: string; format: string }): string[] {
  // a clip's start and its markers are in its source's time
  const srcFrames = (rec: number) => s.tc + i.in + Math.round(((rec - i.rec) * s.fps) / tl.fps);
  const inner: string[] = [];
  if ((i.zoom ?? 1) !== 1 || i.tilt) {
    const y = Math.round(((i.tilt ?? 0) / tl.height) * 100 * 1000) / 1000;
    inner.push(`<adjust-transform position="0 ${y}" scale="${i.zoom ?? 1} ${i.zoom ?? 1}"/>`);
  }
  for (const m of tl.markers) {
    if (m.rec < i.rec || m.rec >= i.rec + i.len) continue;
    inner.push(`<marker start="${time(srcFrames(m.rec), s.fps)}" duration="${time(1, s.fps)}" value="${esc(m.name)}" note="${esc(m.note)}"/>`);
  }
  const open = `<asset-clip ref="${id.asset}" name="${esc(s.name)}" offset="${time(i.rec, tl.fps)}" start="${time(srcFrames(i.rec), s.fps)}" duration="${time(i.len, tl.fps)}" format="${id.format}" tcFormat="NDF"`;
  return inner.length ? [`          ${open}>`, ...inner.map((l) => `            ${l}`), `          </asset-clip>`] : [`          ${open}/>`];
}
