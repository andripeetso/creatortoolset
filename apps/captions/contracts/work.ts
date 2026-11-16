/**
 * The work package: a core AI Editor step run on one of the asker's own computers instead of on the server. The server
 * keeps the queue, runs each step's gate and every step that reads no video or sound; a computer runs a video step's
 * unchanged code in its own Node process (the one the Mac app bundles) against a working copy seeded from the package,
 * then sends the result back. Routes (api/work/routes.ts, under /api/devices/relay/, Authorization: Bearer ctd_…):
 *   POST work/claim            WorkClaimBody → WorkClaim       take one step (long poll, up to 25 s)
 *   POST work/:id/beat         WorkBeat      → { ok: boolean } renew the lease, report progress; ok false = stop
 *   POST work/:id/ai           AI call as the job's account (the computer never picks an account or provider)
 *   POST work/:id/call         { fn, args }  a server read (workspace context, styles, packs, skills, grade)
 *   GET  work/:id/own?path=    an edit-folder file the package names
 *   PUT  work/:id/file?path=   a result file, before done (allow-listed paths only)
 *   POST work/:id/done         WorkResult    → { ok: boolean } applied only while this computer holds the step
 *   POST work/:id/fail         { error }     → { ok: boolean }
 *   GET  editor/job/:id/footage/:version     the proxy of a file the step names (never the original unless asked)
 * Changes are additive: a field a reader lacks is absent, unknown fields are ignored. A change that can't be additive
 * raises WORK_MIN in the same commit. Design: where-work-runs package design, sections 2.2–2.3.
 */

/** This code's package format. */
export const WORK_V = 1;
/** The oldest computer this server hands work to. */
export const WORK_MIN = 1;

export interface WorkJob {
  id: number;
  kind: string;
  editId: string;
  variant: string;
  /** whose step it is: the account its AI and files are checked against */
  actor: string;
  workspaceId: string;
}

/** A file the step reads, and how this computer gets it: a copy already here first, else the server's proxy. */
export interface WorkFile {
  /** the library version id */
  id: string;
  title: string;
  bytes: number;
  /** quick fingerprint (size + first and last MiB), to find a copy at another path */
  quick?: string;
  /** the index's path for this computer, already translated */
  path?: string;
  /** the server has a proxy to download */
  proxy?: { bytes: number };
  /** the step needs the original (plug-in post steps): only a copy already on this computer will do */
  original?: true;
}

export type WorkTable =
  | "libraries"
  | "assets"
  | "asset_versions"
  | "asset_tags"
  | "descriptions"
  | "transcripts"
  | "stretches"
  | "derivatives"
  | "edit_jobs";

export interface WorkPackage {
  v: number;
  job: WorkJob;
  /** every JSON file of editor/<editId>/: path relative to that folder → text */
  edit: Record<string, string>;
  /** edit-folder media the step reads (generated clips, card clips and stills, previews), fetched with work/:id/own */
  own: { path: string; bytes: number; sha256: string }[];
  /** the job's library rows and this edit's edit_jobs; libraries go with storage_kind 'local' and no storage_config */
  rows: Partial<Record<WorkTable, Record<string, unknown>[]>>;
  files: WorkFile[];
  /** the account's storage folders as paths on this computer (Settings → Storage): where a copy at another path is looked for */
  folders?: string[];
  /** editor/cache/<version>.* the server has: name → base64 */
  caches: Record<string, string>;
  /** the kind's gate output (analyzeGate / indexGate), run on the server at claim */
  gate?: unknown;
  /** aiFor(whoFor(actor)).off per use; null = the asker has AI for it */
  ai: { editor: string | null; analyzer: string | null };
  /** post: the plug-in steps it must have */
  steps?: string[];
}

export interface WorkClaimBody {
  v: number;
  /** plug-in steps installed on this computer */
  steps: string[];
  /** the proxy cache: bytes kept, its size limit, the versions kept offline, and every version whose proxy it holds */
  cache?: { bytes: number; limit?: number; offline?: string[]; versions?: string[] };
  /** this worker runs library jobs too (LibraryPackage): a computer that doesn't say so is never handed one */
  library?: true;
}

/** A proxy a person keeps on their computers (Available offline): its version id, the clip's name and the proxy's size. */
export interface WorkOffline {
  id: string;
  title: string;
  bytes: number;
}

export type WorkClaim = ({ pkg: WorkPackage } | { pkg: null; update?: true; lib?: LibraryPackage }) & {
  /** Settings → Storage → Empty: empty the proxy cache now; the proxies kept offline stay */
  empty?: true;
  /** the proxies to keep (Available offline): never removed by the size limit, downloaded while nothing else runs.
   * Absent: an older server, keep the last list */
  offline?: WorkOffline[];
};

/**
 * A library job run on one of the uploader's own computers (phase 6), on the same road: claim → package → result.
 * Routes under work/lib/:id/ (api/work/library-package.ts): beat, light (the server's light copy), original (only for a
 * proxy of a file only the server has), PUT file?name=, done, fail.
 * - kind "send": a file on this computer, before anything uploads: it makes the probe, card picture, waveform, strip,
 *   proxy and fingerprint here and sends them; the original goes too only to a library that keeps originals ("all").
 * - kinds "proxy", "wave", "sprite", "fingerprint": that one file, of a file the server has (a phone or browser upload).
 */
export interface LibraryPackage {
  v: number;
  job: { id: number; kind: string; versionId: string; libraryId: string; actor: string };
  /** the file, read where it is first (path, quick fingerprint), else the server's light copy (`proxy`) */
  file: WorkFile;
  /** the account's storage folders as paths on this computer */
  folders?: string[];
  /** kind "proxy" of a file only the server has: its original may be downloaded, to make the proxy, and is deleted after */
  original?: { bytes: number };
  /** the server's probe of the file (absent for "send", which probes it here) */
  probe?: Record<string, unknown>;
  /** send: what the library keeps of an upload */
  upload?: "proxies" | "all";
  /** send: wantsProxy's options (library/media/proxy.ts) */
  proxy?: { cloud: boolean; on: boolean };
  /** send: the person said it is a song or a sound effect: no strip, no fingerprint */
  music?: boolean;
  /** transcribe: the sound to cut from the file (library/transcribe.ts soundArgs), sent to the server's /hear for the words */
  audio?: "wav" | "m4a";
}

/** A transcript as the library keeps it (library/transcribe.ts): times in seconds, words with fillers kept. */
export interface LibraryTranscript {
  provider: string;
  model?: string;
  language: string | null;
  segments: { start: number; end: number; text: string }[];
  words: { w: string; s: number; e: number; c?: number }[];
}

/** What came of a library job: the files PUT before (by name), and the small results inline. */
export interface LibraryResult {
  v: number;
  outcome: { done: true } | { error: string };
  files: ("original" | "proxy" | "thumb" | "wave" | "sprite")[];
  probe?: Record<string, unknown>;
  /** the original's SHA-256, read on this computer */
  sha256?: string;
  /** the original's quick fingerprint (files.ts quickPrint), so Locate finds it once it moves */
  quick?: string;
  /** the fingerprint job's JSON */
  fingerprint?: string;
  /** the transcribe job's rows */
  transcript?: LibraryTranscript;
}

export interface WorkBeat {
  line?: string;
  /** bytes done and total of the running download, and seconds left */
  done?: number;
  total?: number;
  leftS?: number;
}

export type WorkOutcome =
  | { done: true }
  | { wait: { seconds: number; line?: string } }
  | { needsKey: string }
  | { limit: { seconds: number; line: string } }
  | { error: string };

export interface WorkResult {
  v: number;
  outcome: WorkOutcome;
  /** JSON files changed or added (path → text) and removed, against the package's copy */
  edit: { put: Record<string, string>; gone: string[] };
  /** paths PUT before done (previews/<v>.mp4, generated clips, editor/cache/*) */
  uploads: string[];
  /** post: source version → its rewritten copy's path on this computer (copies stay there) */
  kept?: Record<string, string>;
  effects: {
    /** rows the step added to the local edit_jobs: this edit's versions and core kinds only */
    queue?: { version: string; kind: string }[];
    /** file the uploaded preview in Review, with the thumbnail and waveform made here */
    review?: { variant: string; fails: unknown[]; thumb: string; wave: string };
  };
}
