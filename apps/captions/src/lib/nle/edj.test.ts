// The EDJ v2 contract (contracts/editor.ts): the shared fixture, the version rule, the marker mapper, and the golden
// vectors the player, the model and the studio engine all test against. The golden is made by the editor's own maths
// (keyframes.ts, trans.ts); `WRITE_GOLDEN=1 npx vitest run src/lib/nle/edj.test.ts` writes it again after a deliberate change.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EDJ_VERSION, KEY_EASES, KEY_PROPS, MARKER_COLORS, TRANS_TYPES, edjVersion, markerToEdj, markerToPublic,
  type Edj, type EdjItem, type EdjTrans, type KeyProp,
} from "@contracts/editor";
import { toSaved, withKeys, type NleTimeline } from "./model";
import { valueAt } from "./keyframes";
import { transSpan, transWeights } from "./trans";

const FIXTURE = new URL("../../../contracts/edj.fixture.json", import.meta.url);
const GOLDEN = new URL("../../../contracts/edj-golden.json", import.meta.url);
const fixture = (): Edj => JSON.parse(readFileSync(FIXTURE, "utf8"));

// ---- the maths is the editor's own (keyframes.ts, trans.ts) ----
const r6 = (n: number) => Math.round(n * 1e6) / 1e6 + 0; // + 0: no -0 in JSON comparisons
const split = transSpan;
const weights = (t: EdjTrans, u: number) => transWeights(t, u) as Record<string, number>;

// ---- the golden's inputs ----
type KeyCase = { name: string; fps: number; sfps: number; prop: KeyProp; item: EdjItem; frames: number[] };
const range = (a: number, b: number, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, k) => a + k * step);
const KEY_CASES: KeyCase[] = [
  { name: "static value, no keys", fps: 25, sfps: 25, prop: "zoom", item: { src: "s", rec: 0, len: 10, in: 0, zoom: 1.2 }, frames: [0, 5, 9] },
  { name: "no keys and no value: the default", fps: 25, sfps: 25, prop: "opacity", item: { src: "s", rec: 0, len: 10, in: 0 }, frames: [0, 9] },
  { name: "ease, same fps", fps: 25, sfps: 25, prop: "zoom", item: { src: "s", rec: 10, len: 60, in: 100, keys: { zoom: [[100, 1, "ease"], [150, 2, "ease"]] } }, frames: range(10, 70, 5) },
  { name: "linear, source at 50 on a 25 timeline", fps: 25, sfps: 50, prop: "pan", item: { src: "s", rec: 0, len: 60, in: 0, keys: { pan: [[0, 0, "linear"], [100, 50, "linear"]] } }, frames: range(0, 60, 5) },
  { name: "hold, then linear", fps: 25, sfps: 25, prop: "tilt", item: { src: "s", rec: 0, len: 80, in: 0, keys: { tilt: [[0, 0, "hold"], [20, -30, "hold"], [40, 10, "linear"], [60, 0, "linear"]] } }, frames: range(0, 70, 5) },
  { name: "keys either side of the visible range, speed 2, 60 on 30", fps: 30, sfps: 60, prop: "zoom", item: { src: "s", rec: 100, len: 20, in: 50, speed: 2, keys: { zoom: [[0, 1, "linear"], [200, 1.5, "linear"]] } }, frames: range(100, 119, 3) },
  { name: "all keys before the visible range: clamps to the last", fps: 30, sfps: 60, prop: "zoom", item: { src: "s", rec: 100, len: 20, in: 50, speed: 2, zoom: 3, keys: { zoom: [[10, 1.2, "ease"], [30, 1.8, "ease"]] } }, frames: [100, 110, 119] },
  { name: "all keys after the visible range: clamps to the first", fps: 25, sfps: 25, prop: "rot", item: { src: "s", rec: 0, len: 10, in: 0, keys: { rot: [[50, -5, "linear"], [60, 5, "linear"]] } }, frames: [0, 9] },
  { name: "slow motion 0.5: half source frames", fps: 25, sfps: 25, prop: "opacity", item: { src: "s", rec: 40, len: 30, in: 10, speed: 0.5, keys: { opacity: [[10, 0, "ease"], [20, 1, "linear"]] } }, frames: range(40, 64, 3) },
  { name: "gain, 24 fps source on a 30 timeline", fps: 30, sfps: 24, prop: "gain_db", item: { src: "s", rec: 0, len: 90, in: 0, gain_db: -6, keys: { gain_db: [[0, -40, "ease"], [24, -6, "hold"], [48, -12, "linear"], [72, -6, "linear"]] } }, frames: range(0, 90, 6) },
];

type TransCase = EdjTrans & { name: string; cut: number };
const TRANS_CASES: TransCase[] = [
  { name: "dissolve, centred", type: "dissolve", len: 12, at: "center", cut: 125 },
  { name: "dissolve, centred, odd length", type: "dissolve", len: 5, at: "center", cut: 50 },
  { name: "dip to black, starting at the cut", type: "dip_black", len: 10, at: "start", cut: 90 },
  { name: "dip to white, ending at the cut", type: "dip_white", len: 8, at: "end", cut: 120 },
  { name: "dip to black, centred, odd length", type: "dip_black", len: 7, at: "center", cut: 30 },
  { name: "sound crossfade, centred", type: "crossfade", len: 12, at: "center", cut: 125 },
];

type Side = { speed: number; sfps: number };
type HandleCase = { name: string; at: EdjTrans["at"]; len: number; fps: number; earlier: Side; later: Side };
const HANDLE_CASES: HandleCase[] = [
  { name: "centred, 50 fps sources, later at 1.5", at: "center", len: 12, fps: 25, earlier: { speed: 1, sfps: 50 }, later: { speed: 1.5, sfps: 50 } },
  { name: "centred, odd, 30 fps later source", at: "center", len: 7, fps: 25, earlier: { speed: 1, sfps: 25 }, later: { speed: 1, sfps: 30 } },
  { name: "starting at the cut", at: "start", len: 10, fps: 25, earlier: { speed: 1, sfps: 25 }, later: { speed: 1, sfps: 25 } },
  { name: "ending at the cut, mixed speeds and rates", at: "end", len: 8, fps: 30, earlier: { speed: 2, sfps: 60 }, later: { speed: 0.5, sfps: 24 } },
];

function golden() {
  return {
    about: [
      "Made by src/lib/nle/edj.test.ts from the formulas below; compare values within 1e-6.",
      "Keys: source frame s = in + (f - rec) * speed * sfps / fps for timeline frame f = floor(t * fps). No keys: the item's own value, else zoom 1, pan 0, tilt 0, rot 0, opacity 1, gain_db 0. s at or before the first key: its value; at or after the last: its value. Between keys k and k+1: u = (s - s_k) / (s_k+1 - s_k); key k's ease decides: hold = v_k, linear = lerp(u), ease = lerp(E(u)), E(u) = 16u^5 below 0.5, else 1 - (2 - 2u)^5 / 2.",
      "Transitions sit on the later clip at cut = its rec. Frames before the cut: start 0, end len, center floor(len / 2). start = cut - that; u = (f - start) / len for f in [start, start + len).",
      "dissolve: the later clip at alpha u over the earlier one at full opacity. dip: weights of earlier clip a, colour, later clip b: u < 0.5: a = 1 - 2u, color = 2u, b = 0; else a = 0, color = 2 - 2u, b = 2u - 1. crossfade: gains a = cos(u * pi / 2), b = sin(u * pi / 2).",
      "Handles in source frames: tail of the earlier clip past its last frame = post * speed * sfps / fps; head of the later clip before its in = pre * speed * sfps / fps (pre / post = timeline frames before / after the cut).",
    ],
    keys: KEY_CASES.map((c) => ({ ...c, values: c.frames.map((f) => r6(valueAt(c.item, c.prop, f, c.fps, c.sfps))) })),
    trans: TRANS_CASES.map((c) => {
      const start = c.cut - split(c).pre;
      const frames = range(start, start + c.len - 1);
      const ws = frames.map((f) => weights(c, (f - start) / c.len));
      const col = (k: string) => ws.map((w) => r6(w[k]!));
      return { ...c, start, frames, ...Object.fromEntries(Object.keys(ws[0]!).map((k) => [k, col(k)])) };
    }),
    handles: HANDLE_CASES.map((c) => {
      const { pre, post } = split(c);
      return { ...c, pre, post, tail: r6((post * c.earlier.speed * c.earlier.sfps) / c.fps), head: r6((pre * c.later.speed * c.later.sfps) / c.fps) };
    }),
  };
}

describe("EDJ v2 contract", () => {
  it("the fixture holds every v2 field in its contract shape", () => {
    const fx = fixture();
    expect(fx.edj_version).toBe(EDJ_VERSION);
    expect(edjVersion(fx)).toBe(2);
    const items = Object.values(fx.tracks).flatMap((t) => t.items);
    const keyed = new Set<string>();
    for (const it of items) {
      for (const [prop, keys] of Object.entries(it.keys ?? {})) {
        expect(KEY_PROPS).toContain(prop);
        keyed.add(prop);
        for (const [k, key] of keys!.entries()) {
          expect(key).toHaveLength(3);
          expect(KEY_EASES).toContain(key[2]);
          if (k) expect(key[0]).toBeGreaterThan(keys![k - 1]![0]);
          keyed.add(key[2]);
        }
      }
      if (it.trans) {
        expect(TRANS_TYPES).toContain(it.trans.type);
        expect(["center", "start", "end"]).toContain(it.trans.at);
        keyed.add(`${it.trans.type}/${it.trans.at}`);
      }
    }
    for (const want of [...KEY_PROPS, ...KEY_EASES]) expect(keyed).toContain(want);
    for (const t of TRANS_TYPES) expect([...keyed].some((k) => k.startsWith(`${t}/`))).toBe(true);
    for (const at of ["center", "start", "end"]) expect([...keyed].some((k) => k.endsWith(`/${at}`))).toBe(true);
    expect(items.some((it) => typeof it.norm_db === "number")).toBe(true);
    expect(items.some((it) => it.grade && Object.keys(it.grade).sort().join() === "contrast,gain,gamma,lift,offset,pivot,sat")).toBe(true);
    const sources = Object.values(fx.sources);
    expect(sources.some((s) => s.camera?.curve && s.camera.from === "file")).toBe(true);
    expect(sources.some((s) => s.camera && "lut" in s.camera)).toBe(true);
    expect(sources.find((s) => s.kind === "design")).toEqual({ kind: "design", design: expect.any(String), frame: expect.any(String), path: expect.stringMatching(/\.png$/), w: expect.any(Number), h: expect.any(Number) });
    for (const m of fx.markers!) expect(Object.keys(MARKER_COLORS)).toContain(m.color);
    for (const f of fx.captions!.from) expect(f.map((x) => typeof x)).toEqual(["number", "number", "string", "number"]);
  });

  it("the editor's model carries every v2 field through untouched", () => {
    const fx = fixture();
    expect(toSaved(withKeys(fx as unknown as NleTimeline))).toEqual(fx);
  });

  it("edjVersion: 1 without v2 fields (markers and grades are version 1), 2 with any one", () => {
    const v1 = (): Edj => {
      const fx = fixture();
      delete fx.captions;
      for (const s of Object.values(fx.sources)) delete s.camera;
      delete fx.sources.title;
      for (const t of Object.values(fx.tracks)) for (const it of t.items) for (const k of ["keys", "trans", "norm_db"]) delete it[k];
      return fx;
    };
    expect(edjVersion(v1())).toBe(1);
    expect(edjVersion({ timeline: { fps: 25 }, sources: {}, tracks: {} })).toBe(1);
    const each: ((e: Edj) => void)[] = [
      (e) => (e.captions = fixture().captions),
      (e) => (e.sources.cam!.camera = { curve: "slog3", on: false }),
      (e) => (e.sources.t = fixture().sources.title!),
      (e) => (e.tracks.V1!.items[0]!.keys = {}),
      (e) => (e.tracks.V2!.items[1]!.trans = { type: "dissolve", len: 4, at: "center" }),
      (e) => (e.tracks.A1!.items[0]!.norm_db = 0),
    ];
    for (const add of each) {
      const e = v1();
      add(e);
      expect(edjVersion(e)).toBe(2);
    }
  });

  it("maps markers both ways: Resolve names in the EDJ, OTIO names in this app's Timeline", () => {
    const edj = fixture().markers!;
    expect(edj.map(markerToPublic)).toEqual([
      { rec: 0, name: "L01 Hook", color: "BLUE", note: "" },
      { rec: 125, name: "L02", color: "MAGENTA", note: "the roll lands here" },
      { rec: 200, name: "CTA", color: "RED", note: "" },
    ]);
    // the EDJ → public → EDJ trip keeps all but `dur`, which the public marker has no field for
    expect(edj.map(markerToPublic).map(markerToEdj)).toEqual([
      { frame: 0, name: "L01 Hook", color: "Blue" },
      { frame: 125, name: "L02", color: "Lavender", note: "the roll lands here" },
      { frame: 200, name: "CTA", color: "Red" },
    ]);
    const pub = Object.values(MARKER_COLORS).map((color, rec) => ({ rec, name: `L${rec}`, color, note: rec % 2 ? "a note" : "" }));
    expect(pub.map(markerToEdj).map(markerToPublic)).toEqual(pub);
    expect(markerToEdj({ rec: 3, name: "x", color: "ORANGE", note: "" }).color).toBe("Orange");
  });

  it("the golden vectors are what the stated formulas give", () => {
    const want = golden();
    if (process.env.WRITE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(want, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, xs: string) => `[${xs.split(/,\s+/).join(", ")}]`) + "\n");
    expect(JSON.parse(readFileSync(GOLDEN, "utf8"))).toEqual(want);
  });
});
