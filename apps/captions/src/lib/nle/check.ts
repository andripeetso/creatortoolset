// A timeline a person saved by hand, judged before a server keeps and renders it: the rules a render needs, in one place
// for every server that takes the editor's whole timeline. It only reads: every field it does not know is kept as sent.
// The rules about files on disk and which footage may play where belong to the server that has them.

import { edjVersion, KEY_EASES, KEY_PROPS, TRANS_TYPES, type Edj, type Renders } from "@contracts/editor";
import { handlesAt, maxLen, withKeys, type NleItem, type NleTimeline } from "./model";

/** What a timeline's version is refused with when this server's renders don't take it yet; the editor greys those controls with it. */
export const NOT_RENDERED = "Not in this server's renders yet";

/** A clip field's value that changes nothing (a field left out changes nothing too). */
const NEUTRAL: Record<string, unknown> = { zoom: 1, pan: 0, tilt: 0, rot: 0, opacity: 1, speed: 1, gain_db: 0, fade_in: 0, fade_out: 0, enabled: true, freeze: false, hidden: false, mute: false };
/** The clip fields the editor's controls set, and the track ones. */
const CLIP_FIELDS = ["zoom", "pan", "tilt", "rot", "opacity", "speed", "gain_db", "fade_in", "fade_out", "enabled", "flip", "crop", "freeze"];
const TRACK_FIELDS = ["hidden", "mute"];
const used = (v: unknown, f: string) =>
  v !== undefined && v !== null && v !== "" && (f === "crop" ? Array.isArray(v) && v.some((x) => x !== 0) : !(f in NEUTRAL) || v !== NEUTRAL[f]);

/**
 * What the timeline uses that `renders` doesn't draw: "<track> <field>" for a clip or track field, "<track>" for a track
 * with clips on it that isn't drawn at all. The editor's gate and the save both compare it with the timeline as it was
 * opened, so a draft that came with such a field (a planned edit's speeds) keeps it, and nothing new is added.
 */
export function unrendered(tl: NleTimeline, renders: Renders): string[] {
  const out = new Set<string>();
  for (const [id, t] of Object.entries(tl.tracks ?? {})) {
    const ok = renders.tracks[id];
    if (!ok) {
      if (t.items?.length) out.add(id);
      continue;
    }
    for (const f of TRACK_FIELDS) if (used(t[f], f) && !ok.includes(f)) out.add(`${id} ${f}`);
    for (const it of t.items ?? []) for (const f of CLIP_FIELDS) if (used(it[f], f) && !ok.includes(f)) out.add(`${id} ${f}`);
  }
  return [...out];
}

/** What `tl` uses that the renders don't draw and `base` (the timeline as it was opened) didn't use already. */
export const newlyUnrendered = (tl: NleTimeline, renders: Renders, base?: NleTimeline) => {
  const had = new Set(base ? unrendered(base, renders) : []);
  return unrendered(tl, renders).filter((x) => !had.has(x));
};

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const whole = (x: unknown, min = 0) => Number.isInteger(x) && (x as number) >= min;
const KEY_OK: Partial<Record<string, (v: number) => boolean>> = { zoom: (v) => v > 0, opacity: (v) => v >= 0 && v <= 1, gain_db: (v) => v <= 60 };
const AT = ["center", "start", "end"];

/** What is wrong with a clip's version-2 fields: keys of known props in frame order, a known transition, norm_db a number. */
function v2Problems(it: NleItem): string[] {
  const out: string[] = [];
  const ks = it.keys as unknown;
  if (ks !== undefined) {
    if (!ks || typeof ks !== "object" || Array.isArray(ks)) return ["its keys aren't a list per property"];
    for (const [prop, list] of Object.entries(ks)) {
      if (!(KEY_PROPS as readonly string[]).includes(prop)) out.push(`${prop} can't be keyed`);
      else if (!Array.isArray(list) || !list.every((k) => Array.isArray(k) && k.length === 3 && num(k[0]) && num(k[1]) && (KEY_EASES as readonly string[]).includes(k[2]) && (KEY_OK[prop]?.(k[1]) ?? true)))
        out.push(`its ${prop} keys aren't [frame, value, ease] with usable values`);
      else if (list.some((k, i) => i > 0 && k[0] <= list[i - 1][0])) out.push(`its ${prop} keys aren't in frame order, one per frame`);
    }
  }
  const tr = it.trans as unknown as Record<string, unknown> | undefined;
  if (tr !== undefined && !(tr && typeof tr === "object" && (TRANS_TYPES as readonly string[]).includes(tr.type as string) && AT.includes((tr.at ?? "center") as string) && whole(tr.len, 1)))
    out.push(`the transition ${JSON.stringify(tr)} isn't a known type and place with a length in whole frames`);
  if ("norm_db" in it && !(num(it.norm_db) && Math.abs(it.norm_db) <= 60)) out.push(`norm_db ${JSON.stringify(it.norm_db)} isn't a usable number`);
  return out;
}

/**
 * The timeline's problems that would fail a render on a server whose renders draw `renders` (empty: it can be kept). A
 * version above its `edj_version` (or one that isn't a whole number) is refused, never saved down, and so is a field or a
 * track the renders don't draw that `base` (the draft as it is kept) didn't have: it would vanish from the render.
 */
export function handCheck(tl: NleTimeline, renders: Renders, base?: NleTimeline): string[] {
  const said = tl.edj_version;
  if (said !== undefined && (!Number.isInteger(said) || (said as number) < 1)) return [`it was saved by an editor this server doesn't know (version ${JSON.stringify(said)})`];
  const need = Math.max(typeof said === "number" ? said : 1, edjVersion(tl as unknown as Edj));
  if (need > renders.edj_version) return [`${NOT_RENDERED}: it uses version ${need} of the timeline, this server renders version ${renders.edj_version}`];
  const extra = newlyUnrendered(tl, renders, base);
  if (extra.length) return [`${NOT_RENDERED}: ${extra.join(", ")}`];
  const t = tl.timeline ?? ({} as NleTimeline["timeline"]);
  if (!(["fps", "width", "height"] as const).every((k) => num(t[k]) && (t[k] as number) > 0)) return ["its frame rate or size isn't set"];
  const fps = t.fps;
  const sources = tl.sources ?? {};
  const bad: string[] = [];
  const at = (track: string, it: NleItem) => {
    const s = num(it.rec) ? it.rec / fps : 0;
    const name = String(sources[it.src]?.name ?? sources[it.src]?.path ?? "a clip").split("/").pop();
    return `${track} at ${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")} (${name})`;
  };
  let clips = 0;
  for (const [id, tr] of Object.entries(tl.tracks ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[VA]/.test(id) || !Array.isArray(tr?.items)) {
      bad.push(`${id}: not a track`);
      continue;
    }
    let end = -1;
    for (const it of [...tr.items].sort((a, b) => (num(a.rec) ? a.rec : 0) - (num(b.rec) ? b.rec : 0))) {
      const where = at(id, it);
      if (!whole(it.rec) || !whole(it.in) || !whole(it.len, 1)) {
        bad.push(`${where}: its start, source in or length isn't a whole number of frames`);
        continue;
      }
      clips++;
      for (const [k, ok] of [["speed", (v: number) => v > 0], ["zoom", (v: number) => v > 0], ["opacity", KEY_OK.opacity], ["gain_db", KEY_OK.gain_db], ["pan"], ["tilt"], ["rot"]] as const) {
        if (k in it && !(num(it[k]) && (!ok || ok(it[k] as number)))) bad.push(`${where}: ${k} ${JSON.stringify(it[k])} isn't a usable number`);
      }
      const c = it.crop as unknown;
      if (c !== undefined && !(Array.isArray(c) && c.length === 4 && c.every((x) => num(x) && x >= 0 && x < 1) && c[0] + c[2] < 1 && c[1] + c[3] < 1))
        bad.push(`${where}: the crop ${JSON.stringify(c)} isn't four edges between 0 and 1 that leave a picture`);
      if (![undefined, "", "h", "v", "hv"].includes(it.flip as string)) bad.push(`${where}: flip ${JSON.stringify(it.flip)} isn't h, v or hv`);
      bad.push(...v2Problems(it).map((x) => `${where}: ${x}`));
      const fi = it.fade_in ?? 0;
      const fo = it.fade_out ?? 0;
      if (!whole(fi) || !whole(fo) || fi + fo > it.len) bad.push(`${where}: the fades ${JSON.stringify(fi)} in, ${JSON.stringify(fo)} out aren't whole frames that fit in the clip`);
      if (it.rec < end) bad.push(`${where}: it starts on top of the clip before it on ${id}`);
      end = Math.max(end, it.rec + it.len);
      const src = sources[it.src];
      if (!src) {
        bad.push(`${where}: its source isn't in the timeline`);
        continue;
      }
      const on = it.enabled !== false && tr.enabled !== false && !tr.hidden && !tr.mute;
      if (on && num(src.dur) && !it.freeze) {
        const over = it.in + Math.ceil((it.len * (it.speed ?? 1) * (num(src.fps) ? src.fps : fps)) / fps - 1e-6) - src.dur;
        if (over > 0) bad.push(`${where}: runs ${over} source frames past the end of the file`);
      }
    }
  }
  // transitions: each needs its clips' handles
  if (!bad.length) {
    const k = withKeys(tl);
    for (const [id, tr] of Object.entries(k.tracks)) {
      for (const it of tr.items) {
        if (!it.trans || it.enabled === false) continue;
        const h = handlesAt(k, it._k!);
        if (!h || it.trans.len > maxLen(h, it.trans.at ?? "center"))
          bad.push(`${at(id, it)}: its ${it.trans.len}-frame transition needs more of the clips past the cut than their files have: shorten it or slip a clip`);
      }
    }
  }
  if (!bad.length && !clips) bad.push("there is nothing on the timeline");
  return bad;
}

/** handCheck's problems as one line, the first six named. */
export const refusal = (bad: string[]) => `Can't render this timeline: ${bad.slice(0, 6).join("; ")}${bad.length > 6 ? `; and ${bad.length - 6} more` : ""}`;
