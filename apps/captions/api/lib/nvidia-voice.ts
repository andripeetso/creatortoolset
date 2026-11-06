import http2 from "node:http2";

/**
 * NVIDIA Maxine Studio Voice on NVIDIA's hosted API (build.nvidia.com, NVIDIA_API_KEY).
 * Plain gRPC over Node's own HTTP/2 and no
 * generated code: the request and the answer are each one bytes field
 * (protobuf field 1), a WAV going up in 64 KB pieces and coming back. The
 * 48k-hq model takes up to 32 MB / 6 min a request, so 5-minute pieces with
 * a second of context either side; it answers ~145 ms late (measured
 * 2026-09-29), measured per piece and shifted out.
 */

export const SR = 48000;
const HOST = "https://grpc.nvcf.nvidia.com:443";
const METHOD = "/nvidia.ai4m.studiovoice.v1.StudioVoice/EnhanceAudio";
const FUNCTION_ID = "3f0aeba3-6d91-4465-b8cc-cc2aef355186"; // build.nvidia.com/nvidia/studiovoice, 48k-hq
const PIECE = 300 * SR;
const PAD = SR;
const DEFAULT_LAG = Math.round(0.145 * SR);

/** NVIDIA said no (the key, the credits): not worth a retry. */
export class NvidiaRefused extends Error {}

/** protobuf: field 1, length-delimited */
export function field1(data: Buffer): Buffer {
  const head = [0x0a];
  let n = data.length;
  do {
    head.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n > 0);
  return Buffer.concat([Buffer.from(head), data]);
}

export function unfield1(msg: Buffer): Buffer {
  if (msg[0] !== 0x0a) return Buffer.alloc(0);
  let n = 0;
  let mul = 1;
  let i = 1;
  for (;;) {
    const b = msg[i++];
    n += (b & 0x7f) * mul;
    mul *= 128;
    if (!(b & 0x80)) return msg.subarray(i, i + n);
  }
}

/** gRPC's length-prefixed messages */
export const frame = (msg: Buffer): Buffer => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(msg.length, 1);
  return Buffer.concat([head, msg]);
};

export function unframe(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i + 5 <= buf.length; ) {
    const n = buf.readUInt32BE(i + 1);
    out.push(buf.subarray(i + 5, i + 5 + n));
    i += 5 + n;
  }
  return out;
}

/** mono float samples -> 16-bit PCM WAV */
export function wav16(x: Float32Array, sr = SR): Buffer {
  const out = Buffer.alloc(44 + x.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + x.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sr, 24);
  out.writeUInt32LE(sr * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return out;
}

/** A PCM WAV (16/24/32-bit int or 32-bit float) -> its first channel. */
export function readWav(buf: Buffer): { sr: number; x: Float32Array } {
  let fmt = { format: 1, channels: 1, sr: SR, bits: 16 };
  for (let i = 12; i + 8 <= buf.length; ) {
    const id = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(i + 8), channels: buf.readUInt16LE(i + 10), sr: buf.readUInt32LE(i + 12), bits: buf.readUInt16LE(i + 22) };
    } else if (id === "data") {
      const step = (fmt.bits / 8) * fmt.channels;
      const end = Math.min(buf.length, i + 8 + size);
      const n = Math.floor((end - i - 8) / step);
      const x = new Float32Array(n);
      for (let k = 0, p = i + 8; k < n; k++, p += step) {
        x[k] = fmt.format === 3 ? buf.readFloatLE(p)
          : fmt.bits === 16 ? buf.readInt16LE(p) / 32768
          : fmt.bits === 24 ? buf.readIntLE(p, 3) / 8388608
          : buf.readInt32LE(p) / 2147483648;
      }
      return { sr: fmt.sr, x };
    }
    i += 8 + size + (size & 1);
  }
  throw new Error("No audio in NVIDIA's answer");
}

/**
 * Samples `y` runs late against `x` (0..400 ms): 1 ms loudness envelopes of
 * the loudest 10 s, cross-correlated (a regenerated voice shares its
 * syllables with the original, not its waveform). Weak match: NVIDIA's
 * usual 145 ms.
 */
export function lagOf(x: Float32Array, y: Float32Array): number {
  const hop = SR / 1000;
  const env = (s: Float32Array) => {
    const e = new Float64Array(Math.floor(s.length / hop));
    for (let f = 0; f < e.length; f++) {
      let sum = 0;
      for (let k = f * hop; k < (f + 1) * hop; k++) sum += s[k] * s[k];
      e[f] = Math.log10(sum / hop + 1e-8);
    }
    return e;
  };
  const a = env(x);
  const b = env(y);
  const most = 400;
  const w = Math.min(10_000, a.length - most);
  if (w < 1000) return DEFAULT_LAG;
  let start = 0;
  let best = -Infinity;
  let run = 0;
  for (let f = 0; f < a.length; f++) {         // the loudest window: where the voice is
    run += a[f] - (f >= w ? a[f - w] : 0);
    if (f >= w - 1 && f - w + 1 + w + most <= b.length && run > best) {
      best = run;
      start = f - w + 1;
    }
  }
  const norm = (v: Float64Array, o: number) => {
    let m = 0;
    for (let i = 0; i < w; i++) m += v[o + i];
    m /= w;
    let s = 0;
    for (let i = 0; i < w; i++) s += (v[o + i] - m) ** 2;
    return { m, s: Math.sqrt(s) || 1 };
  };
  const na = norm(a, start);
  let lag = 0;
  let r = -Infinity;
  for (let d = 0; d <= most && start + d + w <= b.length; d++) {
    const nb = norm(b, start + d);
    let dot = 0;
    for (let i = 0; i < w; i++) dot += (a[start + i] - na.m) * (b[start + d + i] - nb.m);
    const c = dot / (na.s * nb.s);
    if (c > r) {
      r = c;
      lag = d;
    }
  }
  return r > 0.5 ? lag * hop : DEFAULT_LAG;
}

function enhancePiece(key: string, wav: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(HOST);
    const fail = (e: Error) => {
      client.destroy();
      reject(e);
    };
    client.on("error", fail);
    const req = client.request({
      ":method": "POST",
      ":path": METHOD,
      "content-type": "application/grpc",
      te: "trailers",
      authorization: `Bearer ${key}`,
      "function-id": FUNCTION_ID,
    });
    const onAbort = () => fail(new Error("Cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const chunks: Buffer[] = [];
    let status = "";
    let message = "";
    const trailers = (h: http2.IncomingHttpHeaders) => {
      if (h["grpc-status"] !== undefined) status = String(h["grpc-status"]);
      if (h["grpc-message"]) message = decodeURIComponent(String(h["grpc-message"]));
    };
    req.on("response", trailers); // a refusal can come as headers only
    req.on("trailers", trailers);
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("error", fail);
    req.setTimeout(10 * 60_000, () => fail(new Error("NVIDIA didn't answer in 10 minutes")));
    req.on("end", () => {
      signal?.removeEventListener("abort", onAbort);
      client.close();
      if (status && status !== "0") {
        // UNAUTHENTICATED 16, PERMISSION_DENIED 7, RESOURCE_EXHAUSTED 8
        const refused = ["16", "7", "8"].includes(status);
        const why = `NVIDIA ${refused ? "refused it" : "failed"} (gRPC ${status}${message ? `: ${message}` : ""})`;
        reject(refused ? new NvidiaRefused(why) : new Error(why));
        return;
      }
      resolve(Buffer.concat(unframe(Buffer.concat(chunks)).map(unfield1)));
    });
    for (let i = 0; i < wav.length; i += 65536) req.write(frame(field1(wav.subarray(i, i + 65536))));
    req.end();
  });
}

/**
 * Mono 48 kHz samples -> NVIDIA Studio Voice, as long as the input and
 * lined up with it. `onPiece(done, total)` after each 5-minute piece.
 */
export async function studioVoice(
  key: string,
  x: Float32Array,
  signal?: AbortSignal,
  onPiece?: (done: number, total: number) => void,
): Promise<Float32Array> {
  const out = new Float32Array(x.length);
  const total = Math.ceil(x.length / PIECE);
  for (let a = 0, k = 0; a < x.length; a += PIECE, k++) {
    const lo = Math.max(0, a - PAD);
    const hi = Math.min(x.length, a + PIECE + PAD);
    const got = readWav(await enhancePiece(key, wav16(x.subarray(lo, hi)), signal));
    if (got.sr !== SR) throw new Error(`NVIDIA answered at ${got.sr} Hz, not ${SR}`);
    const lag = lagOf(x.subarray(lo, hi), got.x);
    const keep = Math.min(PIECE, x.length - a);
    out.set(got.x.subarray(lag + (a - lo), lag + (a - lo) + keep), a);
    onPiece?.(k + 1, total);
  }
  return out;
}
