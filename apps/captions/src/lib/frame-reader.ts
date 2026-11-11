// The fast, and in WebKit the only right, way from a video frame to the part of it a picture shows.
// - The preview: drawing a <video> onto a 2D canvas makes WebKit convert the whole frame on the processor first, about
//   23 to 59 ms for a 3008×3130 recording, every frame. The graphics card takes the same frame in about 2 ms and cuts
//   out and scales the part wanted (2.5 ms in all, measured in the Mac's own WebKit).
// - The export: the Mac's WebKit ignores the source rectangle when a decoded frame (VideoFrame) is drawn on a 2D
//   canvas, so the whole frame came out whatever was asked for and no zoom ever reached the file. Through here the
//   part asked for is the part drawn (0.8 of 255 away from the same part cut from a bitmap, which takes 60 ms).
// The 2D canvas then copies that part as it is.

type Part = { x: number; y: number; w: number; h: number };

export type FrameReader = {
  /** Takes a video's current frame, or a decoded frame. False when the graphics context is gone: draw it another way. */
  take: (frame: HTMLVideoElement | VideoFrame) => boolean;
  /**
   * The part `src` of the taken frame (in the frame's own pixels), drawn `w`×`h`: the canvas it is on, with the part
   * at its top left. Null before a frame was taken, or when the context is gone.
   */
  part: (src: Part, frameW: number, frameH: number, w: number, h: number) => HTMLCanvasElement | null;
  dispose: () => void;
};

const VERTEX = `#version 300 es
in vec2 corner;
uniform vec4 part;
out vec2 at;
void main() {
  // the frame's first row is the picture's top: the texture's y runs down, the canvas's up
  at = part.xy + (corner * 0.5 + 0.5) * part.zw;
  gl_Position = vec4(corner.x, -corner.y, 0.0, 1.0);
}`;

// a small negative bias keeps text crisp when the frame is shown smaller than it was recorded
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 at;
uniform sampler2D frame;
out vec4 color;
void main() {
  color = vec4(texture(frame, at, -0.5).rgb, 1.0);
}`;

/** A reader, or null where WebGL 2 is not to be had. */
export function frameReader(): FrameReader | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const program = gl.createProgram();
  const vertex = shader(gl.VERTEX_SHADER, VERTEX);
  const fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  if (!program || !vertex || !fragment) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const part = gl.getUniformLocation(program, "part");

  let gone = false;
  let taken = false;
  const lost = (e: Event) => {
    e.preventDefault();
    gone = true;
  };
  canvas.addEventListener("webglcontextlost", lost);

  return {
    take(frame) {
      if (gone || (frame instanceof HTMLVideoElement && frame.readyState < 2)) return false;
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.generateMipmap(gl.TEXTURE_2D);
        taken = true;
      } catch {
        gone = true; // a frame the page may not read: never again
      }
      return !gone;
    },
    part(src, frameW, frameH, w, h) {
      if (gone || !taken || w < 1 || h < 1) return null;
      // the canvas only ever grows, so dragging a slider that resizes the picture does not reallocate it each step
      if (canvas.width < w || canvas.height < h) {
        canvas.width = Math.max(canvas.width, w);
        canvas.height = Math.max(canvas.height, h);
      }
      gl.viewport(0, canvas.height - h, w, h);
      gl.uniform4f(part, src.x / frameW, src.y / frameH, src.w / frameW, src.h / frameH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", lost);
      gone = true;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
