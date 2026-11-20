// The editor's player draws its pictures here, on the graphics card (WebGL 2): a 2D canvas makes WebKit convert each
// video frame on the processor first (23–59 ms for a ~3000 px frame), the card takes it in about 1 ms (frame-reader.ts,
// and measured again for this stage in the Mac's own WebKit). It takes the same drawing calls as a 2D canvas
// (setTransform, transform, save/restore, globalAlpha, fillStyle, filter, fillRect, clearRect, drawImage with a source
// and a destination rectangle), so NlePlayer composes one way for both, plus what a 2D canvas can't: a picture's camera
// conversion (a 3D LUT, tetrahedral, as ffmpeg's lut3d) and grade (the CDL, contracts/grade.ts), a blurred fill, and the
// scopes. A picture smaller than its source averages the source pixels it covers, as frame-reader does.
// The frame is composed in the file's own code values, as the renderer composes it (so the LUT, the grade and the
// scopes see what the engine sees), and taken to the screen in present(): there, in WebKit, BT.709 video goes through
// the same display step the <video> element and a 2D canvas give it, so the plain <video>, a 2D canvas and this stage
// look alike. Stills, text and fills are sRGB as they are: they take the inverse step on the way in (toCodes), so they
// come out of present() as a 2D canvas shows them.

import type { GradeCdl, LutTable } from "./looks";

/** A colour change on a picture: the camera conversion, then the grade (looks.ts). */
export type Look = { lut?: LutTable | null; grade?: GradeCdl | null };
type M = [number, number, number, number, number, number];
type Target = { fb: WebGLFramebuffer | null; tex: WebGLTexture | null; w: number; h: number; used?: number };
type Tex = { tex: WebGLTexture; w: number; h: number; gen: number; used: number; mips: boolean; still: boolean };
type State = { m: M; alpha: number; fill: string; filter: string; look: Look | null };

/** The calls NlePlayer draws with: a CanvasRenderingContext2D has all of them, a GlPainter too. */
export interface Painter {
  globalAlpha: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
  filter: string;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

const VERTEX = `#version 300 es
in vec2 corner;
uniform mat3 toPx;  // the unit square to target px
uniform vec2 size;  // the target, px
uniform float flip; // 1 on screen; -1 into a texture, so its first row is the top, as a video's is
uniform vec4 src;   // the part of the texture: x, y, w, h (0-1)
out vec2 uv;
void main() {
  vec2 c = (toPx * vec3(corner, 1.0)).xy / size * 2.0 - 1.0;
  uv = src.xy + corner * src.zw;
  gl_Position = vec4(c.x, -c.y * flip, 0.0, 1.0);
}`;

const PICTURE = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
uniform sampler2D pic;
uniform sampler3D lut;
uniform int solid;     // 1: the fill colour, no picture
uniform vec4 fill;     // premultiplied
uniform float alpha;
uniform vec4 inside;   // the source rectangle (uv min, max) samples stay in
uniform vec2 texSize;
uniform int invert;
uniform float lutN;    // points per side, 0 for none
uniform int graded;
uniform vec3 slope;
uniform vec3 offs;
uniform vec3 power;
uniform float sat;
uniform float shown;   // > 0: video codes to the screen, as WebKit shows BT.709 video (gamma 'shown', then sRGB)
uniform float unshown; // > 0: an sRGB still or text into codes, the inverse of that step
out vec4 color;
vec3 at(ivec3 p) { return texelFetch(lut, p, 0).rgb; }
// ffmpeg lut3d interp=tetrahedral, on the table's points themselves (texel centres)
vec3 tetra(vec3 c) {
  vec3 s = clamp(c, 0.0, 1.0) * (lutN - 1.0);
  vec3 f = min(floor(s), vec3(lutN - 2.0));
  vec3 d = s - f;
  ivec3 a = ivec3(f);
  ivec3 b = a + 1;
  vec3 c000 = at(a), c111 = at(b);
  if (d.r > d.g) {
    if (d.g > d.b) return (1.0 - d.r) * c000 + (d.r - d.g) * at(ivec3(b.x, a.y, a.z)) + (d.g - d.b) * at(ivec3(b.x, b.y, a.z)) + d.b * c111;
    if (d.r > d.b) return (1.0 - d.r) * c000 + (d.r - d.b) * at(ivec3(b.x, a.y, a.z)) + (d.b - d.g) * at(ivec3(b.x, a.y, b.z)) + d.g * c111;
    return (1.0 - d.b) * c000 + (d.b - d.r) * at(ivec3(a.x, a.y, b.z)) + (d.r - d.g) * at(ivec3(b.x, a.y, b.z)) + d.g * c111;
  }
  if (d.b > d.g) return (1.0 - d.b) * c000 + (d.b - d.g) * at(ivec3(a.x, a.y, b.z)) + (d.g - d.r) * at(ivec3(a.x, b.y, b.z)) + d.r * c111;
  if (d.b > d.r) return (1.0 - d.g) * c000 + (d.g - d.b) * at(ivec3(a.x, b.y, a.z)) + (d.b - d.r) * at(ivec3(a.x, b.y, b.z)) + d.r * c111;
  return (1.0 - d.g) * c000 + (d.g - d.r) * at(ivec3(a.x, b.y, a.z)) + (d.r - d.b) * at(ivec3(b.x, b.y, a.z)) + d.b * c111;
}
void main() {
  if (solid == 1) { color = fill * alpha; return; }
  // drawn smaller than the source: the average of the source pixels one output pixel covers (up to 8x8 samples, then
  // from a smaller mip level), as frame-reader.ts
  vec2 per = (abs(dFdx(uv)) + abs(dFdy(uv))) * texSize;
  float lod = max(0.0, log2(max(per.x, per.y) / 8.0));
  vec2 n = clamp(ceil(per - 0.001), 1.0, 8.0);
  vec2 foot = per / texSize;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    if (float(j) >= n.y) break;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= n.x) break;
      sum += textureLod(pic, clamp(uv + ((vec2(float(i), float(j)) + 0.5) / n - 0.5) * foot, inside.xy, inside.zw), lod);
    }
  }
  vec4 t = sum / (n.x * n.y);
  vec3 c = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
  if (unshown > 0.0) c = pow(mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)), vec3(1.0 / unshown));
  if (invert == 1) c = 1.0 - c;
  if (lutN > 1.0) c = tetra(c);
  if (graded == 1) {
    // the engine's grade reads its float RGB through a 1D LUT over 0-1.1; the browser's picture stops at 1, so the two
    // differ only on superwhites
    c = pow(max(c * slope + offs, 0.0), power);
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = y + sat * (c - y);
  }
  if (shown > 0.0) {
    vec3 l = pow(clamp(c, 0.0, 1.0), vec3(shown));
    c = mix(12.92 * l, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l));
  }
  float a = t.a * alpha;
  color = vec4(clamp(c, 0.0, 1.0) * a, a);
}`;

// a Gaussian along `dir`, then `dimBy` taken off (a blurred fill's darkening)
const BLUR = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D pic;
uniform vec2 dir;
uniform float sigma;
uniform float dimBy;
out vec4 color;
void main() {
  float r = min(ceil(sigma * 3.0), 64.0);
  vec4 sum = vec4(0.0);
  float ws = 0.0;
  for (int i = -64; i <= 64; i++) {
    float x = float(i);
    if (abs(x) > r) continue;
    float w = exp(-x * x / (2.0 * sigma * sigma));
    sum += texture(pic, uv + dir * x) * w;
    ws += w;
  }
  color = sum / ws;
  color.rgb = max(color.rgb - dimBy * color.a, 0.0);
}`;

// the scopes: one point per sample of the frame, added up where it lands (waveform: column and luma; vectorscope: Cb, Cr)
const SCOPE_VERTEX = `#version 300 es
uniform sampler2D frame;
uniform ivec2 grid;
uniform int mode;
uniform vec2 size;
uniform float weight;
out vec3 tint;
void main() {
  ivec2 g = ivec2(gl_VertexID % grid.x, gl_VertexID / grid.x);
  vec2 at = (vec2(g) + 0.5) / vec2(grid);
  vec4 t = texture(frame, at);
  vec3 c = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec2 p;
  if (mode == 0) {
    p = vec2(at.x * size.x, size.y - 3.0 - clamp(y, 0.0, 1.1) / 1.1 * (size.y - 6.0));
    tint = vec3(0.5, 0.6, 0.5);
  } else {
    float s = (size.y / 2.0 - 4.0) / 0.45;
    p = size / 2.0 + vec2((c.b - y) / 1.8556, -(c.r - y) / 1.5748) * s;
    tint = c * 0.6 + 0.25;
  }
  tint *= weight * t.a;
  gl_Position = vec4(p / size * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;
const SCOPE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 tint;
out vec4 color;
void main() { color = vec4(tint, 1.0); }`;
const SCOPE_SHOW = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D pic;
uniform int soft; // 1: the sums are floats, shown as GradePanel's scopes (1 - e^-0.45x)
out vec4 color;
void main() {
  vec3 a = texture(pic, uv).rgb;
  color = vec4(soft == 1 ? 1.0 - exp(-a * 0.45) : a, 1.0);
}`;

const ID: M = [1, 0, 0, 1, 0, 0];
const mul = (p: M, q: M): M => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];

/** A CSS colour as drawn here: #rgb, #rrggbb, rgb(), rgba(); premultiplied 0-1. Anything else is black. */
export function rgba(css: string): [number, number, number, number] {
  let c = [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1];
    c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(1);
  } else {
    const fn = /^rgba?\(([^)]*)\)$/i.exec(css.trim());
    if (fn) {
      const v = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      c = [v[0] / 255, v[1] / 255, v[2] / 255, v.length > 3 ? v[3] : 1].map((x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0));
    }
  }
  return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
}

/** An sRGB colour (premultiplied) as codes that come out of present()'s display step as that colour (gamma 0: as is). */
export function toCodes([r, g, b, a]: [number, number, number, number], gamma: number): [number, number, number, number] {
  if (!gamma || !a) return [r, g, b, a];
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [x, y, z] = [r, g, b].map((v) => lin(v / a) ** (1 / gamma) * a);
  return [x, y, z, a];
}

/** WebKit's display step for BT.709 video on Apple's systems (gamma 1.961, then sRGB), as present() takes the frame;
 *  0 elsewhere (the codes shown as they are). */
export const SHOWN_GAMMA =
  typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent) ? 1.961 : 0;

/** What a 2D canvas filter string asks for that this stage draws: invert(1) and blur(Npx). */
export function filterOf(f: string): { invert: boolean; blur: number } {
  return { invert: /invert\(\s*1/.test(f), blur: Number(/blur\(\s*([\d.]+)px/.exec(f)?.[1] ?? 0) };
}

export type GlStage = {
  canvas: HTMLCanvasElement;
  /** what draws on screen */
  screen: GlPainter;
  /** an offscreen frame (a shot is composed there, then its zoom drawn); drawn by passing `layer.token` as a source */
  layer: GlPainter & { token: HTMLCanvasElement };
  /** true once it can't draw: its context is gone (it may come back: the canvas gets webglcontextrestored) or `tainted` */
  readonly lost: boolean;
  /** a picture the page may not read was drawn (another origin without CORS): for good, draw the 2D way */
  readonly tainted: boolean;
  /** sizes the frame and the layer (device px), ready for a new frame */
  begin(w: number, h: number): void;
  /** the composed frame onto the screen */
  present(): void;
  /** the waveform and vectorscope of the frame composed last, `w`×`h` each, read back in one go */
  scopes(w: number, h: number): [ImageData, ImageData] | null;
  /** lets go of a source's texture (its element is gone) */
  forget(src: CanvasImageSource): void;
  dispose(): void;
};
type Rect = [number, number, number, number];
export type GlPainter = Painter & {
  look: Look | null;
  /** a darkened blur of `src`'s part: made `w`×`h`, blurred `sigma` px there, `dimBy` (0-1) off, drawn at `dst` */
  blurFill(src: CanvasImageSource, part: Rect, w: number, h: number, sigma: number, dimBy: number, dst: Rect): void;
};

/** The stage, or null where WebGL 2 is not to be had. */
export function glStage(): GlStage | null {
  const canvas = document.createElement("canvas");
  // the drawn frame is kept between draws, so a read later (Design on This Frame copies the viewer's canvas) gets the
  // picture, not a blank: the canvas is only the viewer's size, so keeping it costs about nothing
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
  // (a test's stand-in context is not one)
  if (!gl || typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) return null;
  const compile = (vs: string, fs: string) => {
    const p = gl.createProgram()!;
    for (const [type, text] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, "corner");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program");
    const u = new Proxy({} as Record<string, WebGLUniformLocation | null>, { get: (o, k: string) => (k in o ? o[k] : (o[k] = gl.getUniformLocation(p, k))) });
    return { p, u };
  };
  let progs: Record<"pic" | "blur" | "scope" | "show", ReturnType<typeof compile>>;
  try {
    progs = { pic: compile(VERTEX, PICTURE), blur: compile(VERTEX, BLUR), scope: compile(SCOPE_VERTEX, SCOPE_FRAGMENT), show: compile(VERTEX, SCOPE_SHOW) };
  } catch (e) {
    console.warn("The player's graphics stage didn't start", e);
    return null;
  }
  // float frames can be drawn into: the scopes' sums, and the frame kept in more than 8 bits
  const floatSums = !!gl.getExtension("EXT_color_buffer_float");
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let lost = false;
  let tainted = false;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
  });

  const texParams = (min: number) => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  };
  // offscreen frames by name, made again only when their size changes
  const targets = new Map<string, Target>();
  const target = (name: string, w: number, h: number, float = false): Target => {
    let t = targets.get(name);
    if (t && t.w === w && t.h === h) return Object.assign(t, { used: gen });
    if (t) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    texParams(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    targets.set(name, (t = { fb, tex, w, h, used: gen }));
    return t;
  };
  const onScreen: Target = { fb: null, tex: null, w: 1, h: 1 };
  // shortcut: WebKit on Apple's systems shows BT.709 video with gamma 1.961 into sRGB (measured: within 0.5/255 on
  // average of its 2D canvas); another browser is taken to show the codes as they are. Measure Chrome's if it matters.
  const shownGamma = SHOWN_GAMMA;
  const use = (t: Target) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
  };

  // each source's texture: a video's taken again once per frame drawn, a picture's once
  let gen = 0;
  const texs = new Map<CanvasImageSource, Tex>();
  const layerToken = document.createElement("canvas");
  type Src = { tex: WebGLTexture; w: number; h: number; t?: Tex; srgb?: boolean };
  const sourceOf = (src: CanvasImageSource): Src | null => {
    if (src === layerToken) {
      const t = targets.get("layer");
      return t ? { tex: t.tex!, w: t.w, h: t.h } : null;
    }
    const v = src instanceof HTMLVideoElement;
    const [w, h] = v ? [src.videoWidth, src.videoHeight] : src instanceof HTMLImageElement ? [src.naturalWidth, src.naturalHeight] : [(src as HTMLCanvasElement).width, (src as HTMLCanvasElement).height];
    if (!w || !h) return null;
    gl.activeTexture(gl.TEXTURE0);
    let t = texs.get(src);
    if (!t) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      texParams(gl.LINEAR);
      texs.set(src, (t = { tex, w, h, gen: -1, used: gen, mips: false, still: src instanceof HTMLImageElement }));
    }
    t.used = gen;
    if (t.gen !== gen && !(t.still && t.gen >= 0)) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      } catch {
        // a picture the page may not read (another origin without CORS): the player draws the 2D way from now on
        tainted = true;
        return null;
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      Object.assign(t, { gen, w, h, mips: false });
    }
    // a still or a 2D canvas is sRGB, a video is codes
    return { tex: t.tex, w: t.w, h: t.h, t, srgb: !v };
  };

  const quad = (to: Target, m: M, x: number, y: number, w: number, h: number) => {
    const { u } = progs.pic;
    const q = mul(m, [w, 0, 0, h, x, y]);
    gl.uniformMatrix3fv(u.toPx, false, [q[0], q[1], 0, q[2], q[3], 0, q[4], q[5], 1]);
    gl.uniform2f(u.size, to.w, to.h);
    gl.uniform1f(u.flip, to.fb ? -1 : 1);
  };
  const lutTexs = new Map<LutTable, WebGLTexture>();
  const lutTex = (l: LutTable) => {
    let t = lutTexs.get(l);
    if (!t) {
      t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_3D, t);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
      // an array upload refuses the premultiplying the pictures take
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, l.size, l.size, l.size, 0, gl.RGB, gl.FLOAT, l.values);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      lutTexs.set(l, t);
    }
    return t;
  };

  // a picture from `src`'s part into `to`: its corner at (dx, dy), dw×dh, under `m`
  const picture = (to: Target, s: Src, m: M, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, alpha: number, invert: boolean, look: Look | null, shown = 0) => {
    const { p, u } = progs.pic;
    gl.useProgram(p);
    use(to);
    // source px per output px; past 8 the shader reads a smaller mip level
    const per = Math.max(sw / Math.max(1e-6, Math.hypot(m[0], m[1]) * Math.abs(dw)), sh / Math.max(1e-6, Math.hypot(m[2], m[3]) * Math.abs(dh)));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    if (per > 8 && s.t && !s.t.mips) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      s.t.mips = true;
    }
    gl.uniform1i(u.pic, 0);
    gl.uniform1i(u.solid, 0);
    gl.uniform1f(u.alpha, alpha);
    gl.uniform2f(u.texSize, s.w, s.h);
    gl.uniform4f(u.src, sx / s.w, sy / s.h, sw / s.w, sh / s.h);
    gl.uniform4f(u.inside, (sx + 0.5) / s.w, (sy + 0.5) / s.h, (sx + sw - 0.5) / s.w, (sy + sh - 0.5) / s.h);
    gl.uniform1i(u.invert, invert ? 1 : 0);
    gl.uniform1f(u.shown, shown);
    gl.uniform1f(u.unshown, s.srgb ? shownGamma : 0);
    const lut = look?.lut;
    gl.uniform1f(u.lutN, lut ? lut.size : 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut ? lutTex(lut) : null);
    gl.uniform1i(u.lut, 1);
    const g = look?.grade;
    gl.uniform1i(u.graded, g ? 1 : 0);
    if (g) {
      gl.uniform3fv(u.slope, g.slope);
      gl.uniform3fv(u.offs, g.offset);
      gl.uniform3fv(u.power, g.power);
      gl.uniform1f(u.sat, g.sat);
    }
    quad(to, m, dx, dy, dw, dh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const solid = (to: Target, m: M, x: number, y: number, w: number, h: number, c: [number, number, number, number], alpha: number) => {
    const { p, u } = progs.pic;
    gl.useProgram(p);
    use(to);
    // no texture bound where the shader could read: the target itself left there is a feedback loop, and the draw is refused
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.uniform1i(u.pic, 0);
    gl.uniform1i(u.lut, 1);
    gl.uniform1i(u.solid, 1);
    gl.uniform4fv(u.fill, c);
    gl.uniform1f(u.alpha, alpha);
    quad(to, m, x, y, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  // `from` blurred into `to` (same size): across, then down with the darkening
  const blur = (from: Target, mid: Target, to: Target, sigma: number, dimBy: number) => {
    const { p, u } = progs.blur;
    gl.useProgram(p);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.pic, 0);
    gl.uniform1f(u.sigma, Math.max(0.01, sigma));
    gl.uniform4f(u.src, 0, 0, 1, 1);
    for (const [a, b, dir, dim] of [[from, mid, [1 / from.w, 0], 0], [mid, to, [0, 1 / from.h], dimBy]] as const) {
      use(b);
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform2f(u.dir, dir[0], dir[1]);
      gl.uniform1f(u.dimBy, dim);
      gl.uniformMatrix3fv(u.toPx, false, [b.w, 0, 0, 0, b.h, 0, 0, 0, 1]);
      gl.uniform2f(u.size, b.w, b.h);
      gl.uniform1f(u.flip, -1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.enable(gl.BLEND);
  };

  const painter = (to: () => Target): GlPainter => {
    let s: State = { m: ID, alpha: 1, fill: "#000", filter: "none", look: null };
    const stack: State[] = [];
    return {
      get globalAlpha() { return s.alpha; },
      set globalAlpha(v) { s.alpha = v; },
      get fillStyle() { return s.fill; },
      set fillStyle(v) { s.fill = String(v); },
      get filter() { return s.filter; },
      set filter(v) { s.filter = v; },
      get look() { return s.look; },
      set look(v) { s.look = v; },
      setTransform: (a, b, c, d, e, f) => void (s.m = [a, b, c, d, e, f]),
      transform: (a, b, c, d, e, f) => void (s.m = mul(s.m, [a, b, c, d, e, f])),
      save: () => void stack.push({ ...s }),
      restore: () => void (s = stack.pop() ?? s),
      fillRect: (x, y, w, h) => solid(to(), s.m, x, y, w, h, toCodes(rgba(s.fill), shownGamma), s.alpha),
      clearRect(x, y, w, h) {
        gl.disable(gl.BLEND);
        solid(to(), s.m, x, y, w, h, [0, 0, 0, 0], 1);
        gl.enable(gl.BLEND);
      },
      drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
        if (lost || tainted || sw <= 0 || sh <= 0) return;
        const got = sourceOf(src);
        if (!got) return;
        const { invert, blur: sigma } = filterOf(s.filter);
        const t = to();
        if (sigma < 0.5) return picture(t, got, s.m, sx, sy, sw, sh, dx, dy, dw, dh, s.alpha, invert, s.look);
        // blurred as a 2D canvas filter blurs: drawn first, then blurred in the target's px, then laid on
        const a = target("fxA", t.w, t.h);
        const b = target("fxB", t.w, t.h);
        use(a);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        picture(a, got, s.m, sx, sy, sw, sh, dx, dy, dw, dh, 1, invert, s.look);
        blur(a, b, a, sigma, 0);
        picture(t, { tex: a.tex!, w: a.w, h: a.h }, ID, 0, 0, a.w, a.h, 0, 0, t.w, t.h, s.alpha, false, null);
      },
      blurFill(src, [sx, sy, sw, sh], w, h, sigma, dimBy, [dx, dy, dw, dh]) {
        const got = lost || tainted ? null : sourceOf(src);
        if (!got || w < 1 || h < 1) return;
        // by size: a transition's two shots each keep theirs
        const a = target(`smallA${w}x${h}`, w, h);
        const b = target(`smallB${w}x${h}`, w, h);
        gl.disable(gl.BLEND);
        picture(a, got, ID, sx, sy, sw, sh, 0, 0, w, h, 1, false, null);
        gl.enable(gl.BLEND);
        blur(a, b, a, sigma, dimBy);
        picture(to(), { tex: a.tex!, w, h }, s.m, 0, 0, w, h, dx, dy, dw, dh, s.alpha, false, null);
      },
    };
  };
  const screen = painter(() => targets.get("main") ?? onScreen);
  const layer = Object.assign(painter(() => targets.get("layer") ?? onScreen), { token: layerToken });

  return {
    canvas,
    screen,
    layer,
    get lost() { return lost || tainted || gl.isContextLost(); },
    get tainted() { return tainted; },
    begin(w, h) {
      gen++;
      if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
      Object.assign(onScreen, { w, h });
      // half floats where they can be drawn into: no 8-bit steps before the display step
      target("main", w, h, floatSums);
      target("layer", w, h, floatSums);
      // textures of pictures not drawn for a while let go (the player also lets each one go as it drops it)
      for (const [k, t] of texs) if (gen - t.used > 120) {
        gl.deleteTexture(t.tex);
        texs.delete(k);
      }
      for (const [k, t] of targets) if (k.startsWith("small") && gen - (t.used ?? 0) > 120) {
        gl.deleteFramebuffer(t.fb);
        gl.deleteTexture(t.tex);
        targets.delete(k);
      }
    },
    present() {
      const main = targets.get("main");
      if (lost || !main) return;
      gl.disable(gl.BLEND);
      picture(onScreen, { tex: main.tex!, w: main.w, h: main.h }, ID, 0, 0, main.w, main.h, 0, 0, main.w, main.h, 1, false, null, shownGamma);
      gl.enable(gl.BLEND);
    },
    scopes(w, h) {
      const frame = targets.get("main");
      if (lost || tainted || !frame) return null;
      const [cw, ch] = [frame.w, frame.h];
      // the waveform on the left half, the vectorscope on the right, read back together (one wait for the card)
      const sums = target(`sums${floatSums ? "F" : ""}`, 2 * w, h, floatSums);
      use(sums);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // a sample per scope column, rows as many as keep the frame's shape (at most 256): more only cost time
      const gw = Math.min(cw, w);
      const gh = Math.max(1, Math.min(256, Math.round((gw * ch) / cw)));
      const { p, u } = progs.scope;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frame.tex);
      gl.uniform1i(u.frame, 0);
      gl.uniform2i(u.grid, gw, gh);
      gl.uniform2f(u.size, w, h);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (const mode of [0, 1]) {
        gl.viewport(mode * w, 0, w, h);
        gl.uniform1i(u.mode, mode);
        // a flat colour lights its place right up, a spread one shows its shape (tuned by eye against GradePanel's)
        const k = (w * h) / (mode === 0 ? 2 : 8) / (gw * gh);
        gl.uniform1f(u.weight, floatSums ? k : Math.max(1 / 255, k / 6));
        gl.drawArrays(gl.POINTS, 0, gw * gh);
      }
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const out = target("scope", 2 * w, h);
      use(out);
      gl.disable(gl.BLEND);
      const show = progs.show;
      gl.useProgram(show.p);
      gl.bindTexture(gl.TEXTURE_2D, sums.tex);
      gl.uniform1i(show.u.pic, 0);
      gl.uniform1i(show.u.soft, floatSums ? 1 : 0);
      gl.uniform4f(show.u.src, 0, 0, 1, 1);
      gl.uniformMatrix3fv(show.u.toPx, false, [2 * w, 0, 0, 0, h, 0, 0, 0, 1]);
      gl.uniform2f(show.u.size, 2 * w, h);
      gl.uniform1f(show.u.flip, -1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.enable(gl.BLEND);
      const both = new Uint8Array(2 * w * h * 4);
      gl.readPixels(0, 0, 2 * w, h, gl.RGBA, gl.UNSIGNED_BYTE, both);
      const [wave, vector] = [new ImageData(w, h), new ImageData(w, h)];
      for (let y = 0; y < h; y++) {
        wave.data.set(both.subarray(y * 8 * w, y * 8 * w + 4 * w), y * 4 * w);
        vector.data.set(both.subarray(y * 8 * w + 4 * w, (y + 1) * 8 * w), y * 4 * w);
      }
      return [wave, vector];
    },
    forget(src) {
      const t = texs.get(src);
      if (t) gl.deleteTexture(t.tex);
      texs.delete(src);
    },
    dispose() {
      lost = true;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
