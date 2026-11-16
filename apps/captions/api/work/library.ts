import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WORK_V, type LibraryPackage, type LibraryResult, type LibraryTranscript } from "../../contracts/work";
import { env } from "../lib/env";
import { sha256File } from "../lib/uploads";
import { fingerprint } from "../library/fingerprint";
import { looksLikeSong, probe, type ProbeSummary } from "../library/media/probe";
import { makeProxy, wantsProxy } from "../library/media/proxy";
import { makeSprite } from "../library/media/sprite";
import { makeThumb } from "../library/media/thumb";
import { makeWave } from "../library/media/wave";
import { ffmpegTo } from "../library/media/run";
import { soundArgs } from "../library/transcribe";
import { sizeOf } from "./cache";
import { client, type WorkerOptions } from "./computer";
import { copyHere, quickPrint, resolveFiles, type Progress } from "./files";

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

const LINE: Record<string, string> = {
  send: "Preparing the file to send",
  proxy: "Making the proxy",
  wave: "Making the waveform",
  sprite: "Making the strip of frames",
  fingerprint: "Reading the file for duplicates",
  transcribe: "Transcribing",
};

/** The running library job, for Cancel (the menu). */
let current: AbortController | null = null;
export const cancelLibraryJob = (): void => current?.abort(new Error("Stopped"));

/** Makes what `lib` asks for from `src` into `dir`; `hear` turns a transcript's sound into its words (the server's /hear). */
export async function makeDerived(lib: LibraryPackage, src: string, dir: string, hear?: (sound: string) => Promise<LibraryTranscript>): Promise<Made> {
  const out = (name: string) => path.join(dir, name);
  const kind = lib.job.kind;
  if (kind === "send") {
    const p = await probe(src);
    const files: Made["files"] = {};
    if (p.vcodec) await makeThumb(src, (files.thumb = out("thumb.jpg")), p.duration, !!p.cover, p.turn);
    await makeWave(src, (files.wave = out("wave.json")), !!p.acodec);
    if (wantsProxy(p, lib.proxy ?? { cloud: false, on: false })) await makeProxy(src, (files.proxy = out("proxy.mp4")), !!p.cover || !p.vcodec);
    let print: string | undefined;
    if (p.vcodec && !p.cover && !lib.music && !looksLikeSong(lib.file.title, p)) {
      // from the lighter copy, as the server's steps read it (library/worker.ts lighter)
      const light = files.proxy ?? src;
      await makeSprite(light, (files.sprite = out("sprite.jpg")), p.duration, p.turn);
      print = JSON.stringify(await fingerprint(light, p.duration, dir));
    }
    // the original goes only to a library that keeps originals: in a proxies-only library it never leaves this computer
    if (lib.upload === "all") files.original = src;
    const quick = await quickPrint(src);
    return { files, probe: p as unknown as Record<string, unknown>, sha256: await sha256File(src), ...(quick ? { quick } : {}), ...(print ? { fingerprint: print } : {}) };
  }
  const p = lib.probe as unknown as ProbeSummary | undefined;
  if (!p) throw new Error("The file is not probed yet");
  if (kind === "proxy") return { files: { proxy: (await makeProxy(src, out("proxy.mp4"), !!p.cover || !p.vcodec), out("proxy.mp4")) } };
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

/** Runs one claimed library job to the end: done or fail sent, or nothing when the server took it back. */
export async function runLibraryJob(lib: LibraryPackage, o: WorkerOptions): Promise<"done" | "failed" | "stopped"> {
  const c = client(o);
  const base = `work/lib/${lib.job.id}`;
  const ctl = new AbortController();
  current = ctl;
  const beat: { line?: string } & Partial<Progress> = { line: LINE[lib.job.kind] };
  const progress = (p: Progress) => Object.assign(beat, p);
  const still = () => {
    for (const k of ["done", "total", "leftS"] as const) delete beat[k];
  };
  let taken = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = () => {
    timer = setTimeout(async () => {
      try {
        if ((await c.post<{ ok: boolean }>(`${base}/beat`, beat)).ok === false) {
          taken = true;
          ctl.abort(new Error("Taken back"));
          return;
        }
      } catch {
        // the server is away a moment: the lease outlives a few missed beats
      }
      if (!ctl.signal.aborted) loop();
    }, o.beatMs ?? 10_000);
  };
  loop();
  const dir = path.join(env.dataDir, "library-work", String(lib.job.id));
  try {
    await mkdir(dir, { recursive: true });
    // where the file is on this computer first; a download only when it is not here
    let src = await copyHere(lib.file, lib.folders ?? []);
    if (!src && lib.original) {
      src = path.join(dir, "original");
      const res = await c.raw(`${base}/original`, { signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(`Could not download ${lib.file.title} (${res.status})`);
      await pipeline(Readable.fromWeb(res.body as never), counter(lib.original.bytes, progress), createWriteStream(src), { signal: ctl.signal });
      if (sizeOf(src) !== lib.original.bytes) throw new Error(`${lib.file.title} came incomplete`);
    }
    src ??= (await resolveFiles({ files: [lib.file] }, { folders: [], get: (_v, init) => c.raw(`${base}/light`, init), signal: ctl.signal, progress }))[lib.file.id]!;
    still();
    const made = await makeDerived(lib, src, dir, async (sound) => {
      const res = await c.raw(`${base}/hear`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(statSync(sound).size) },
        body: Readable.toWeb(createReadStream(sound)) as ReadableStream,
        signal: ctl.signal,
        duplex: "half",
      } as RequestInit);
      const said = (await res.json().catch(() => ({}))) as LibraryTranscript & { error?: string };
      if (!res.ok) throw new Error(said.error ?? `The server could not hear it (${res.status})`);
      return said;
    });
    ctl.signal.throwIfAborted();

    const names = Object.keys(made.files) as LibraryResult["files"];
    const total = names.reduce((n, k) => n + statSync(made.files[k]!).size, 0);
    let before = 0;
    const sent: LibraryResult["files"] = [];
    for (const name of names) {
      const file = made.files[name]!;
      const size = statSync(file).size;
      const at = before;
      const res = await c.raw(`${base}/file?name=${name}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": String(size) },
        body: Readable.toWeb(createReadStream(file).pipe(counter(size, (p) => progress({ ...p, done: at + p.done, total })))) as ReadableStream,
        signal: ctl.signal,
        duplex: "half",
      } as RequestInit);
      before += size;
      if (res.ok) sent.push(name);
      else console.warn(`[work] library job ${lib.job.id}: the server refused ${name} (${res.status})`);
    }
    still();
    const { files: _, ...rest } = made;
    const result: LibraryResult = { v: WORK_V, outcome: { done: true }, files: sent, ...rest };
    if (!taken) await c.post(`${base}/done`, result);
    return "done";
  } catch (e) {
    if (ctl.signal.aborted) {
      if (!taken) await c.post(`${base}/fail`, { error: "Stopped" }).catch(() => {});
      return "stopped";
    }
    await c.post(`${base}/fail`, { error: e instanceof Error ? e.message : String(e) }).catch((x) => console.warn(`[work] library job ${lib.job.id}:`, x));
    return "failed";
  } finally {
    clearTimeout(timer);
    ctl.abort();
    if (current === ctl) current = null;
    // the job's folder, with an original downloaded for the proxy: never kept
    await rm(dir, { recursive: true, force: true });
  }
}
