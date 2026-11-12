/**
 * Colour grades of talent shots, made by hand only (nothing grades on its own):
 * primaries (lift / gamma / gain / offset per channel, contrast about a pivot,
 * saturation), always one ASC CDL, so a grade is the same in an editing app's
 * CDL node, in a preview render and here.
 *
 * Colours are data-level RGB, 0-1 (a Sony's superwhites run to 1.095).
 */

export type RGB = [number, number, number];
export interface Grade {
  lift: RGB;
  gamma: RGB;
  gain: RGB;
  offset: RGB;
  contrast: number;
  pivot: number;
  sat: number;
}
export const NEUTRAL: Grade = { lift: [0, 0, 0], gamma: [0, 0, 0], gain: [1, 1, 1], offset: [0, 0, 0], contrast: 1, pivot: 0.435, sat: 1 };
export const LUMA: RGB = [0.2126, 0.7152, 0.0722];
/** the vectorscope's skin tone line, degrees from +Cb */
export const SKIN_LINE = 123;

export const full = (g?: Partial<Grade> | null): Grade => ({ ...NEUTRAL, ...(g ?? {}) });
export const luma = (c: readonly number[]) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
const map3 = (f: (i: number) => number): RGB => [f(0), f(1), f(2)];

/** Primaries -> ASC CDL (slope, offset, power, saturation). */
export function cdl(g?: Partial<Grade> | null) {
  const x = full(g);
  const c = x.contrast;
  return {
    slope: map3((i) => c * x.gain[i] * (1 - x.lift[i])),
    offset: map3((i) => c * x.gain[i] * x.lift[i] + x.pivot * (1 - c) + x.offset[i]),
    power: map3((i) => 2 ** -x.gamma[i]),
    sat: x.sat,
  };
}

const satAbout = (c: RGB, sat: number): RGB => {
  const y = luma(c);
  return map3((i) => y + sat * (c[i] - y));
};

/** The grade on one colour, as a CDL does (negatives to 0 before the power). */
export function apply(g: Partial<Grade> | null | undefined, rgb: readonly number[]): RGB {
  const { slope, offset, power, sat } = cdl(g);
  return satAbout(map3((i) => Math.max(rgb[i] * slope[i] + offset[i], 0) ** power[i]), sat);
}

export function fromHue(y: number, hue: number, chroma: number): RGB {
  const a = (hue * Math.PI) / 180;
  const r = y + 1.5748 * chroma * Math.sin(a);
  const b = y + 1.8556 * chroma * Math.cos(a);
  return [r, (y - 0.2126 * r - 0.0722 * b) / 0.7152, b];
}

export function isNeutral(g?: Partial<Grade> | null): boolean {
  const { slope, offset, power, sat } = cdl(g);
  return [...slope, ...power, sat].every((v) => Math.abs(v - 1) < 1e-4) && offset.every((v) => Math.abs(v) < 1e-4);
}

export const sameGrade = (a?: Partial<Grade> | null, b?: Partial<Grade> | null) => {
  const [x, y] = [cdl(a), cdl(b)];
  const va = [...x.slope, ...x.offset, ...x.power, x.sat];
  const vb = [...y.slope, ...y.offset, ...y.power, y.sat];
  return va.every((v, i) => Math.abs(v - vb[i]) < 1e-4);
};

// ---- wheels: a per-channel triple as the wheels show it ------------------------
// master = its luma (the ring), the ball = where the rest sits on the
// vectorscope (Cb right, Cr up). Lossless both ways.

export function toWheel(v: RGB): { master: number; cb: number; cr: number } {
  const y = luma(v);
  return { master: y, cb: (v[2] - y) / 1.8556, cr: (v[0] - y) / 1.5748 };
}

export function fromWheel(master: number, cb: number, cr: number): RGB {
  const r = master + 1.5748 * cr;
  const b = master + 1.8556 * cb;
  return [r, (master - 0.2126 * r - 0.0722 * b) / 0.7152, b];
}

// ---- the server keeps what it can trust ------------------------------------

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? r4(v) : undefined);
const triple = (v: unknown, lo: number, hi: number): RGB | undefined => {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  const t = v.map((x) => num(x, lo, hi));
  return t.every((x) => x !== undefined) ? (t as RGB) : undefined;
};

/** A grade from a request, or undefined if any part is missing or out of range. */
export function cleanGrade(v: unknown): Grade | undefined {
  const g = v as Record<string, unknown> | null;
  if (!g || typeof g !== "object") return undefined;
  const out = {
    lift: triple(g.lift, -1, 1),
    gamma: triple(g.gamma, -2, 2),
    gain: triple(g.gain, 0, 4),
    offset: triple(g.offset, -1, 1),
    contrast: num(g.contrast, 0, 4),
    pivot: num(g.pivot, 0.01, 0.99),
    sat: num(g.sat, 0, 4),
  };
  return Object.values(out).every((x) => x !== undefined) ? (out as Grade) : undefined;
}

// ---- Review's live view -------------------------------------------------------
// Review plays the render, which has the old grade baked in (and clipped). A
// new grade shows as the exact change from the old one: undo the old
// saturation, then per channel the old curve's inverse into the new curve,
// then the new saturation. Only detail the render clipped can't come back.

export function delta(from: Partial<Grade> | null | undefined, to: Partial<Grade> | null | undefined) {
  const a = cdl(from);
  const b = cdl(to);
  const curve = (i: number) => (v: number) => {
    const x = (Math.max(v, 0) ** (1 / a.power[i]) - a.offset[i]) / (a.slope[i] || 1e-6);
    return Math.min(Math.max(Math.max(x * b.slope[i] + b.offset[i], 0) ** b.power[i], 0), 1);
  };
  const curves = [curve(0), curve(1), curve(2)];
  const pre = 1 / (a.sat || 1e-6);
  return {
    pre,
    curves,
    post: b.sat,
    /** one colour of the render, as the new grade would show it */
    apply: (c: readonly number[]): RGB => {
      const u = satAbout([c[0], c[1], c[2]], pre);
      return satAbout(map3((i) => curves[i](u[i])), b.sat);
    },
  };
}

/** feColorMatrix values for saturation about Rec.709 luma. */
export function satMatrix(sat: number): string {
  const k = LUMA.map((l) => (1 - sat) * l);
  const row = (i: number) => [0, 1, 2].map((j) => k[j] + (i === j ? sat : 0)).concat([0, 0]).map((v) => +v.toFixed(5)).join(" ");
  return `${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0`;
}

/** feFuncR/G/B tableValues for a delta's curves. */
export const tables = (curves: ((v: number) => number)[], n = 65) =>
  curves.map((f) => Array.from({ length: n }, (_, k) => +f(k / (n - 1)).toFixed(4)).join(" "));

// ---- words -------------------------------------------------------------------------

const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;

/** A grade in a colorist's words, for a comment. */
export function describeGrade(g: Partial<Grade>): string {
  const x = full(g);
  const ring = (v: RGB) => toWheel(v).master;
  const tinted = (["lift", "gamma", "gain", "offset"] as const).filter((k) => {
    const w = toWheel(x[k]);
    return Math.hypot(w.cb, w.cr) > 0.004;
  });
  const parts = [
    Math.abs(ring(x.lift)) > 0.004 && `lift ${ring(x.lift).toFixed(2)}`,
    Math.abs(ring(x.gamma)) > 0.004 && `gamma ${ring(x.gamma).toFixed(2)}`,
    Math.abs(ring(x.gain) - 1) > 0.004 && `gain ${ring(x.gain).toFixed(2)}`,
    Math.abs(ring(x.offset)) > 0.004 && `offset ${ring(x.offset).toFixed(3)}`,
    tinted.length > 0 && `balance on ${tinted.join("/")}`,
    Math.abs(x.contrast - 1) > 0.004 && `contrast ${x.contrast.toFixed(2)}`,
    Math.abs(x.sat - 1) > 0.004 && `sat ${pct(x.sat - 1)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no grade";
}
