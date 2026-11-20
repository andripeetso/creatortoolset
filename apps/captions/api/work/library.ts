import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hostsOriginals } from "../../contracts/library";
import { WORK_V, type LibraryPackage, type LibraryResult, type LibraryTranscript, type PictureInput, type PicturePackage, type PictureResult } from "../../contracts/work";
import { env } from "../lib/env";
import { sha256File } from "../lib/uploads";
import { fingerprint } from "../library/fingerprint";
import { looksLikeSong, probe, type ProbeSummary } from "../library/media/probe";
import { makeProxy, wantsProxy } from "../library/media/proxy";
import { makeSprite } from "../library/media/sprite";
import { makeThumb } from "../library/media/thumb";
import { makeWave } from "../library/media/wave";
import { ffmpegTo, withSignal } from "../library/media/run";
import { soundArgs } from "../library/transcribe";
import { cutStills } from "../library/describe";
import { cardVector, CARD_SEG, sheetVectors } from "../library/pictures";
import { SHEET_FORMAT, type LookSheet } from "../library/shots";
import { keepProxy, proxiesDir, proxyBytes, roomFor, sizeOf } from "./cache";
import { machineDisks } from "./disks";
import { client, type WorkerOptions } from "./computer";
import { copyHere, quickPrint, resolveFiles, type Progress } from "./files";
import { takeTurn, TURN_LINE } from "./turn";

/**
 * A library job on this computer (contracts/work.ts LibraryPackage), with the library's own media code, so what is made
 * here equals what the server would make. The file is read where it is on this computer first; else, for the proxy of a
 * file only the server has, its original is downloaded into this job's folder, and for the other kinds the server's
 * proxy. The job's folder goes when the job ends, so a downloaded original is never kept.
 *
 * "send" (a file here that nothing uploaded yet): probe, card picture, waveform, proxy, strip and fingerprint, and the
 * original's checksum; the original itself is sent only to a library that keeps originals ("all").
 */

type Made = Pick<LibraryResult, "probe" | "sha256" | "quick" | "fingerprint" | "transcript"> & { files: Partial<Record<LibraryResult["files"][number], string>> };

/** The library job kinds this computer runs (derive), said in its claim: a server hands an older computer only the first ones. */
export const LIBRARY_HERE = ["send", "probe", "thumb", "proxy", "wave", "sprite", "fingerprint", "transcribe", "describe"];

const LINE: Record<string, string> = {
  send: "Preparing the file to send",
  probe: "Reading the file",
  thumb: "Making the card picture",
  describe: "Picking stills for the description",
  proxy: "Making the proxy",
  wave: "Making the waveform",
  sprite: "Making the strip of frames",
  fingerprint: "Reading the file for duplicates",
  transcribe: "Transcribing",
};

/** The running library job, for Cancel (the menu) and a stop of this worker. */
let current: AbortController | null = null;
let running: Promise<unknown> | null = null;
export const cancelLibraryJob = (): void => current?.abort(new Error("Stopped"));
/** Stops the running library job and waits for it to end (its processes killed, its fail sent), at most `ms`. */
export async function stopLibraryJob(ms: number): Promise<void> {
  cancelLibraryJob();
  if (running) await Promise.race([running.catch(() => {}), new Promise((r) => setTimeout(r, ms).unref())]);
}

/** How long the server may answer nothing before this computer gives a job up: the lease (library-package.ts) less a minute. */
export const GIVE_UP_MS = (300 - 60) * 1000;

/**
 * Makes what `lib` asks for from `src` into `dir`; `hear` turns a transcript's sound into its words (the server's /hear).
 * `signal`: the job's; each ffmpeg or ffprobe it starts is killed when it aborts (media/run.ts spawnKillable).
 */
export function makeDerived(lib: LibraryPackage, src: string, dir: string, hear?: (sound: string) => Promise<LibraryTranscript>, signal?: AbortSignal): Promise<Made> {
  return signal ? withSignal(signal, () => derive(lib, src, dir, hear)) : derive(lib, src, dir, hear);
}

async function derive(lib: LibraryPackage, src: string, dir: string, hear?: (sound: string) => Promise<LibraryTranscript>): Promise<Made> {
  const out = (name: string) => path.join(dir, name);
  const kind = lib.job.kind;
  if (kind === "send") {
    const p = await probe(src);
    const files: Made["files"] = {};
    if (p.vcodec) await makeThumb(src, (files.thumb = out("thumb.jpg")), p.duration, !!p.cover, p.turn);
    await makeWave(src, (files.wave = out("wave.json")), !!p.acodec);
    if (wantsProxy(p, lib.proxy ?? { cloud: false, on: false }) && (await makeProxy(src, out("proxy.mp4"), !!p.cover || !p.vcodec, lib.proxy?.quality, p.duration))) files.proxy = out("proxy.mp4");
    let print: string | undefined;
    if (p.vcodec && !p.cover && !lib.music && !looksLikeSong(lib.file.title, p)) {
      // from the lighter copy, as the server's steps read it (library/worker.ts lighter)
      const light = files.proxy ?? src;
      await makeSprite(light, (files.sprite = out("sprite.jpg")), p.duration, p.turn);
      print = JSON.stringify(await fingerprint(light, p.duration, dir));
    }
    // the original goes only to a library that keeps originals: in a proxies-only library it never leaves this computer
    if (hostsOriginals(lib.upload)) files.original = src;
    const quick = await quickPrint(src);
    return { files, probe: p as unknown as Record<string, unknown>, sha256: await sha256File(src), ...(quick ? { quick } : {}), ...(print ? { fingerprint: print } : {}) };
  }
  if (kind === "probe") {
    const quick = await quickPrint(src);
    return { files: {}, probe: (await probe(src)) as unknown as Record<string, unknown>, ...(quick ? { quick } : {}) };
  }
  const p = lib.probe as unknown as ProbeSummary | undefined;
  if (!p) throw new Error("The file is not probed yet");
  if (kind === "thumb") return { files: { thumb: (await makeThumb(src, out("thumb.jpg"), p.duration, !!p.cover, p.turn), out("thumb.jpg")) } };
  // as a Mac's stills: cut upright from the file as it is, the clip's own turn added by the server (describe.ts)
  if (kind === "describe") return { files: Object.fromEntries((await cutStills(src, p.duration, 0, dir)).map((f, i) => [`still${i}`, f])) };
  // no proxy when it is no smaller than the original: the server then keeps the original as its light copy
  // one kept on this computer leaves the disk its free-space floor (cache.ts roomFor), else none is made and the original plays
  if (kind === "proxy" && lib.keepProxy && !roomFor(proxyBytes(sizeOf(src) ?? 0, p.duration, lib.proxy?.quality))) return { files: {} };
  if (kind === "proxy") return { files: (await makeProxy(src, out("proxy.mp4"), !!p.cover || !p.vcodec, lib.proxy?.quality, p.duration)) ? { proxy: out("proxy.mp4") } : {} };
  if (kind === "wave") return { files: { wave: (await makeWave(src, out("wave.json"), !!p.acodec), out("wave.json")) } };
  if (kind === "sprite") return { files: { sprite: (await makeSprite(src, out("sprite.jpg"), p.duration, p.turn), out("sprite.jpg")) } };
  if (kind === "fingerprint") return { files: {}, fingerprint: JSON.stringify(await fingerprint(src, p.duration, dir)) };
  if (kind === "transcribe" && hear) {
    // the server's own cut, from this computer's copy: the same sound, so the same words
    const wav = lib.audio !== "m4a";
    const sound = out(wav ? "sound.wav" : "sound.m4a");
    await ffmpegTo(sound, ["-i", src, ...soundArgs(wav)]);
    return { files: {}, transcript: await hear(sound) };
  }
  throw new Error(`No library job ${kind} on this computer`);
}

/** Counts bytes through a stream, with time left from the average rate since `t0`. */
function counter(total: number, report: (p: Progress) => void) {
  let done = 0;
  const t0 = Date.now();
  return new Transform({
    transform(chunk: Buffer, _enc, next) {
      done += chunk.length;
      const s = (Date.now() - t0) / 1000;
      report({ done, total, ...(s > 0.5 && done ? { leftS: Math.ceil((total - done) / (done / s)) } : {}) });
      next(null, chunk);
    },
  });
}

/** Where library jobs make their files: one folder per job, gone when the job ends. */
const scratch = () => path.join(env.dataDir, "library-work");

/** Every job folder a stopped worker left (a crash, kill -9): at start no job runs, so none is live. */
export const sweepScratch = (): Promise<void> => rm(scratch(), { recursive: true, force: true });

/** Whether the scratch disk has CT_LIBRARY_SCRATCH_GB (default 20) free for another job. */
export async function scratchRoom(): Promise<boolean> {
  const want = Number(process.env.CT_LIBRARY_SCRATCH_GB ?? 20) * 2 ** 30;
  await mkdir(env.dataDir, { recursive: true });
  const s = await statfs(env.dataDir);
  return s.bavail * s.bsize >= want;
}

/** What a library job reads: video, sound and pictures, by extension. */
const MEDIA = /\.(mp4|mov|m4v|mxf|mts|m2ts|avi|mkv|webm|3gp|mpg|mpeg|wav|mp3|m4a|aac|aif|aiff|flac|ogg|opus|jpe?g|png|heic|heif|tiff?|webp)$/i;

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * On a computer that takes only library work (CT_WORKER_KINDS=library), the file a job reads must be a regular media file
 * whose real path (links followed) is on a network share it has connected, or in its own proxy cache or job folder. A
 * link out of the share, a folder or any other file: the job fails. A Mac app reads its own disks as always.
 */
export async function mayReadHere(src: string, own: string[], only = process.env.CT_WORKER_KINDS === "library"): Promise<boolean> {
  if (!only) return true;
  try {
    const real = await realpath(src);
    if (!(await stat(real)).isFile()) return false;
    const roots = await Promise.all([...machineDisks().map((d) => d.path), ...own].map((r) => realpath(r).catch(() => null)));
    if (!roots.some((r) => r && within(real, r))) return false;
    // downloaded copies are named here (job folder, proxy cache); a file on a share must say it is media
    return MEDIA.test(real) || own.some((r) => within(real, r));
  } catch {
    return false;
  }
}

/**
 * Runs one claimed library job to the end: done or fail sent, or nothing when the server took it back. Each call names
 * the job's claim (x-ct-claim). A server that answers nothing or a 5xx is asked again until GIVE_UP_MS passed since it
 * last answered (a restart of it costs the job nothing); a 410 (taken back) stops the job and its processes at once.
 */
export function runLibraryJob(lib: LibraryPackage, o: WorkerOptions): Promise<"done" | "failed" | "stopped"> {
  const run = runLibrary(lib, o);
  running = run;
  return run.finally(() => {
    if (running === run) running = null;
  });
}

async function runLibrary(lib: LibraryPackage, o: WorkerOptions): Promise<"done" | "failed" | "stopped"> {
  const claim = lib.job.claim;
  const f = o.fetch ?? fetch;
  const c = client(claim ? { ...o, fetch: (u, i = {}) => f(u, { ...i, headers: { ...(i.headers as Record<string, string>), "x-ct-claim": claim } }) } : o);
  const base = `work/lib/${lib.job.id}`;
  const ctl = new AbortController();
  current = ctl;
  // taken back (410), or the server away past GIVE_UP_MS: the job is no longer this computer's, nothing more is sent
  let taken = false;
  const drop = (why: string) => {
    taken = true;
    ctl.abort(new Error(why));
  };
  let heard = Date.now();
  /** An answer of the server's, or null while it is away (no answer, a 5xx); a 410 drops the job. */
  const heardFrom = (res: Response | null): Response | null => {
    if (res && res.status < 500) {
      heard = Date.now();
      if (res.status === 410) drop("Taken back");
      return res;
    }
    if (Date.now() - heard > (o.giveUpMs ?? GIVE_UP_MS)) drop("The server was away too long");
    return null;
  };
  /** One call for the job, made again every retryMs while the server is away; throws once the job is dropped or stopped. */
  const call = async (send: () => Promise<Response>): Promise<Response> => {
    for (;;) {
      ctl.signal.throwIfAborted();
      const res = heardFrom(await send().catch(() => null));
      ctl.signal.throwIfAborted();
      if (res) return res;
      await new Promise((r) => setTimeout(r, o.retryMs ?? 5000));
    }
  };
  const beat: { line?: string } & Partial<Progress> = { line: LINE[lib.job.kind] };
  const progress = (p: Progress) => Object.assign(beat, p);
  const still = () => {
    for (const k of ["done", "total", "leftS"] as const) delete beat[k];
  };
  let timer: NodeJS.Timeout | undefined;
  // set once the result goes: a beat still on its way is answered 410 for the job just done, which stops nothing
  let closing = false;
  const loop = () => {
    timer = setTimeout(async () => {
      const answer = await c.raw(`${base}/beat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(beat) }).catch(() => null);
      if (closing) return;
      const res = heardFrom(answer);
      // an older server answers a job it took back with ok: false
      if (res?.ok && ((await res.json().catch(() => null)) as { ok?: boolean } | null)?.ok === false) drop("Taken back");
      if (!ctl.signal.aborted) loop();
    }, o.beatMs ?? 10_000);
  };
  loop();
  // named by the claim: a later claim of the same job never shares it; kept until the result is in or the job is dropped
  const dir = path.join(scratch(), claim ? `${lib.job.id}-${claim}` : String(lib.job.id));
  let release = () => {};
  try {
    // this Mac's other servers' work first, one job at a time (turn.ts); the job stays held and beating meanwhile
    beat.line = TURN_LINE;
    release = await takeTurn({ signal: ctl.signal });
    beat.line = LINE[lib.job.kind];
    await mkdir(dir, { recursive: true });
    // where the file is on this computer first; a download only when it is not here
    // its job folder, and the proxy cache once the server has named the account
    const own = [dir, ...(() => {
      try {
        return [proxiesDir()];
      } catch {
        return [];
      }
    })()];
    let src = await copyHere(lib.file, lib.folders ?? [], (p) => mayReadHere(p, own));
    if (!src && lib.original) {
      src = path.join(dir, "original");
      const res = heardFrom(await c.raw(`${base}/original`, { signal: ctl.signal }));
      ctl.signal.throwIfAborted();
      if (!res?.ok || !res.body) throw new Error(`Could not download ${lib.file.title} (${res?.status ?? "no answer"})`);
      await pipeline(Readable.fromWeb(res.body as never), counter(lib.original.bytes, progress), createWriteStream(src), { signal: ctl.signal });
      if (sizeOf(src) !== lib.original.bytes) throw new Error(`${lib.file.title} came incomplete`);
    }
    const light = async (_v: string, init?: RequestInit) => heardFrom(await c.raw(`${base}/light`, init)) ?? new Response(null, { status: 503 });
    src ??= (await resolveFiles({ files: [lib.file] }, { folders: [], get: light, signal: ctl.signal, progress }))[lib.file.id]!;
    if (!(await mayReadHere(src, own))) throw new Error(`${lib.file.title} is not a media file on a share this computer reads`);
    still();
    const made = await makeDerived(lib, src, dir, async (sound) => {
      // once: a 502 is the key's provider failing, and each try is heard (and paid) again
      const res = heardFrom(await c.raw(`${base}/hear`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(statSync(sound).size) },
        body: Readable.toWeb(createReadStream(sound)) as ReadableStream,
        signal: ctl.signal,
        duplex: "half",
      } as RequestInit));
      ctl.signal.throwIfAborted();
      if (!res) throw new Error("The server did not answer the sound");
      const said = (await res.json().catch(() => ({}))) as LibraryTranscript & { error?: string };
      if (!res.ok) throw new Error(said.error ?? `The server could not hear it (${res.status})`);
      return said;
    }, ctl.signal);
    ctl.signal.throwIfAborted();
    // Upload off: the proxy stays in this computer's cache (kept.json) and nothing of it is sent
    if (lib.keepProxy) {
      if (made.files.proxy) keepProxy(lib.file.id, made.files.proxy);
      delete made.files.proxy;
    }

    const names = Object.keys(made.files) as LibraryResult["files"];
    const total = names.reduce((n, k) => n + statSync(made.files[k]!).size, 0);
    let before = 0;
    const sent: LibraryResult["files"] = [];
    for (const name of names) {
      const file = made.files[name]!;
      const size = statSync(file).size;
      const at = before;
      // a proxy is declared before its bytes: the server takes only bytes that hash to it (library/upload-gate.ts)
      const declared = name === "proxy" ? `&sha256=${await sha256File(file)}` : "";
      const res = await call(() =>
        c.raw(`${base}/file?name=${name}${declared}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "content-length": String(size) },
          body: Readable.toWeb(createReadStream(file).pipe(counter(size, (p) => progress({ ...p, done: at + p.done, total })))) as ReadableStream,
          signal: ctl.signal,
          duplex: "half",
        } as RequestInit),
      );
      before += size;
      // a result without one of its files would be filed half: the try fails and the job is made again
      if (!res.ok) throw new Error(`The server refused the ${name} (${res.status})`);
      sent.push(name);
    }
    still();
    const { files: _, ...rest } = made;
    const result: LibraryResult = { v: WORK_V, outcome: { done: true }, files: sent, ...rest };
    closing = true;
    clearTimeout(timer);
    const res = await call(() => c.raw(`${base}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) }));
    if (((await res.json().catch(() => null)) as { ok?: boolean } | null)?.ok) return "done";
    console.warn(`[work] library job ${lib.job.id}: the server did not take the result (${res.status})`);
    return "failed";
  } catch (e) {
    if (taken) return "stopped";
    if (ctl.signal.aborted) {
      await c.post(`${base}/fail`, { error: "Stopped" }).catch(() => {});
      return "stopped";
    }
    await c.post(`${base}/fail`, { error: e instanceof Error ? e.message : String(e) }).catch((x) => console.warn(`[work] library job ${lib.job.id}:`, x));
    return "failed";
  } finally {
    release();
    clearTimeout(timer);
    ctl.abort();
    if (current === ctl) current = null;
    // the job's folder, with an original downloaded for the proxy: never kept
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The sheets the Mac app keeps for `p`'s version (LibraryLookJob.swift: looks/<version>.json in the folder whose "work"
 * folder is this worker's data folder, Shell.swift), when they show the stretches the server has; else none.
 */
async function sheetsHere(p: PicturePackage): Promise<LookSheet[] | null> {
  if (!/^[\w-]{1,100}$/.test(p.versionId)) return null;
  const kept = (await readFile(path.join(env.dataDir, "..", "looks", `${p.versionId}.json`), "utf8")
    .then((t) => JSON.parse(t) as { format?: string; stretches?: number[][]; sheets?: LookSheet[] })
    .catch(() => null));
  if (kept?.format !== SHEET_FORMAT || JSON.stringify(kept.stretches) !== JSON.stringify(p.stretches ?? []) || !Array.isArray(kept.sheets)) return null;
  return kept.sheets.map(({ segs, jpeg }) => ({ segs, jpeg }));
}

const b64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");

/**
 * Search by picture's vectors of one clip (contracts/work.ts PicturePackage): its card picture and look sheets read from
 * the server, or the sheets this Mac keeps, through the server's own picture code; only the vectors go back.
 */
export async function runPictureJob(p: PicturePackage, o: WorkerOptions): Promise<"done" | "failed" | "stopped"> {
  const c = client(o);
  const base = `work/pictures/${p.id}`;
  let taken = false;
  const beat = setInterval(() => {
    c.post<{ ok: boolean }>(`${base}/beat`, {})
      .then((r) => void (r.ok === false && (taken = true)))
      .catch(() => {}); // the server is away a moment: the lease outlives a few missed beats
  }, o.beatMs ?? 10_000);
  let release = () => {};
  try {
    // this Mac's other servers' work first, one job at a time (turn.ts)
    release = await takeTurn();
    if (taken) return "stopped";
    const res = await c.raw(`${base}/input`);
    if (!res.ok) throw new Error(`The server gave no pictures (${res.status})`);
    const input = (await res.json()) as PictureInput;
    const sheets = input.sheets ?? (p.sheets === "here" ? await sheetsHere(p) : null);
    const rows: PictureResult["rows"] = [];
    if (input.card) {
      const vec = await cardVector(Buffer.from(input.card, "base64"), false);
      rows.push({ seg: CARD_SEG, vec: vec ? b64(vec) : null });
    }
    if (sheets) for (const r of await sheetVectors(sheets, false)) rows.push({ seg: r.seg, vec: r.vec ? b64(r.vec) : null });
    if (taken) return "stopped";
    await c.post(`${base}/done`, { v: WORK_V, rows } satisfies PictureResult);
    return "done";
  } catch (e) {
    await c.post(`${base}/fail`, { error: e instanceof Error ? e.message : String(e) }).catch(() => {});
    return "failed";
  } finally {
    release();
    clearInterval(beat);
  }
}
