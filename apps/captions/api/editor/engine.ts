import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { libraryDb } from "../library/db";
import { MAX_ATTEMPTS, type JobRow, type JobTable } from "../library/jobs";
import { CARDS_DRAW_KIND, RESOLVE_KIND } from "../../contracts/devices";
import { announce } from "../lib/sync";
import { analyzeStep, energyFile } from "./analyze";
import { brollStep } from "./broll";
import { cardsStep } from "./cards/step";
import { critiqueStep } from "./critique";
import { eyelineFile } from "./eyeline";
import { allBroll, isPlanned } from "./plan";
import { postStep } from "./post";
import { fileStep, previewStep } from "./preview";
import { scriptStep } from "./script";
import { speakersFile } from "./speakers";
import { draftStep, reframeSpan } from "./timeline";
import { readEdit, readStep, type EditMeta } from "./store";

/**
 * The AI Editor's step registry: one entry per step kind, with where it runs. A `core` kind runs on the server's
 * worker. A `device` kind runs only on a device that declares it (a Mac with Resolve, a card renderer), so the server
 * never claims it. Kinds with no entry at all still reach the server and fail as "No <kind> step yet".
 */

export interface StepContext {
  edit: EditMeta;
  job: JobRow;
  /** "" for a whole-edit step, else the version's name */
  variant: string;
  signal: AbortSignal;
}

export type StepRun = (ctx: StepContext) => Promise<void>;

export interface EditKind {
  source: "core" | "device";
  /** Kinds this one queues when it finishes (for the same edit and variant). */
  next: string[];
  /** Core kinds only: the server's handler. */
  run?: StepRun;
  /** Device kinds: false when the step never reads the edit's footage (it goes to any computer, api/editor/reach.ts) */
  footage?: false;
  /**
   * Core kinds: "computer" when this run reads video or sound, so it goes to one of the asker's own computers first
   * (api/work/place.ts); absent or "server": it reads none and stays on the server. A step whose decodes are all cached
   * stays on the server, so no download is made for a step that reads nothing.
   */
  place?: (edit: EditMeta, variant: string) => Place;
}

export type Place = "server" | "computer";

/** Probe of a library version, or null. */
const probeOf = (id: string): { vcodec?: string } | null => {
  const r = libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?").get(id) as { probe: string | null } | undefined;
  return r?.probe ? (JSON.parse(r.probe) as { vcodec?: string }) : null;
};
/** A source whose loudness (and, with a picture, eye line) analyze has not measured yet. */
const unmeasured = (id: string, eyes: boolean) => !existsSync(energyFile(id)) || (eyes && !!probeOf(id)?.vcodec && !existsSync(eyelineFile(id)));
const computerIf = (yes: boolean): Place => (yes ? "computer" : "server");

/** analyze reads the footage only for an edit cut around speech, and only for a source not measured yet (analyze.ts). */
const analyzePlace = (edit: EditMeta): Place => computerIf(!edit.plan && !allBroll(edit) && edit.sources.some((id) => unmeasured(id, true)));

/**
 * One version's draft: a planned one with a generated shot, one cut around speech from a source not measured yet, or a
 * moment reframed where its faces are not looked at yet (timeline.ts).
 */
function draftPlace(edit: EditMeta, variant: string): Place {
  if (!variant) return "server";
  const plan = readStep(edit.id, "plan");
  const version = plan?.plans.find((p) => p.name === variant);
  if (!version) return "server";
  if (!version.lines.length) return computerIf(!!readStep(edit.id, "shots")?.[variant]?.plan.shots.some((s) => "generate" in s.src));
  const sentences = readStep(edit.id, "analysis")?.sentences ?? [];
  // a reframed moment reads its faces once (speakers.ts)
  const span = reframeSpan(edit, version, sentences);
  if (span && probeOf(span.src)?.vcodec && !existsSync(speakersFile(span.src, span.a, span.b))) return "computer";
  return computerIf(version.lines.some((l) => {
    const src = sentences.find((s) => s.n === l.take.first)?.src;
    return !!src && unmeasured(src, false);
  }));
}

const KINDS: Record<string, EditKind> = {
  analyze: { source: "core", next: ["script"], run: analyzeStep, place: analyzePlace },
  // a planned edit's script indexes its footage, looks at sheets and the song's beats (plan.ts)
  script: { source: "core", next: ["draft"], run: scriptStep, place: (e) => computerIf(isPlanned(e, readStep(e.id, "analysis")?.sentences ?? [])) },
  draft: { source: "core", next: ["broll"], run: draftStep, place: draftPlace },
  // B-roll picks clips by what the library knows of them (probe, descriptions): it reads no video or sound
  broll: { source: "core", next: ["post"], run: brollStep, place: () => "server" },
  // the cards of an edit whose style names an animation style: queued after its B-roll by nextFor, and for no other edit
  // it tiles the cards a computer drew (cards-draw) into one sheet: pictures, no footage or sound
  cards: { source: "core", next: ["post"], run: cardsStep, place: () => "server" },
  // the post-processing steps the edit uses (plug-ins, Settings → AI Editor); with none it only clears its notes
  // with plug-in steps it rewrites the originals, on the computer that has them
  post: { source: "core", next: ["preview"], run: postStep, place: (e) => computerIf(!!e.steps?.length) },
  preview: { source: "core", next: ["file"], run: previewStep, place: () => "computer" },
  // the look at a planned cut the AI made, after its preview (nextFor): it files the cut itself, or queues the fix round's draft
  critique: { source: "core", next: [], run: critiqueStep, place: () => "computer" },
  // marks the cut's library version as made from its sources: rows only, no decoding
  file: { source: "core", next: [], run: fileStep, place: () => "server" },
  // the Resolve bridge (Mac app): handed out only with a Resolve pack installed (api/devices.ts)
  [RESOLVE_KIND]: { source: "device", next: [] },
  // a Mac draws an edit's cards in its sandbox (cards/step.ts asks, cards/device.ts answers)
  [CARDS_DRAW_KIND]: { source: "device", next: [], footage: false },
};

/** A device kind that reads the edit's footage: it goes only to a computer that can get at the files (api/editor/reach.ts). */
export const usesFootage = (kind: string): boolean => KINDS[kind]?.source === "device" && KINDS[kind]!.footage !== false;

/** Where a queued core step goes: "computer" when it reads video or sound (KINDS place). A gone edit: the server, which fails it. */
export function placeOf(job: Pick<JobRow, "kind" | "version_id">): Place {
  const k = KINDS[job.kind];
  if (k?.source !== "core" || !k.place) return "server";
  const vid = job.version_id ?? "";
  const cut = vid.indexOf(":");
  const edit = readEdit(vid.slice(0, cut));
  return edit && !edit.trashedAt ? k.place(edit, vid.slice(cut + 1)) : "server";
}

/** The kinds the server runs (a computer may run them too, through the work package: api/work/routes.ts). */
export const coreKinds = (): string[] => Object.keys(KINDS).filter((k) => KINDS[k]!.source === "core");

/** Registers kinds that a device runs. Called once per kind (at boot, or by tests). */
export function registerDeviceKinds(kinds: string[]): void {
  for (const k of kinds) if (!KINDS[k]) KINDS[k] = { source: "device", next: [] };
}

/** Handler per core kind. The worker's STEPS is this object, so a test can swap one kind's handler. */
export function coreSteps(): Record<string, StepRun> {
  const out: Record<string, StepRun> = {};
  for (const [k, v] of Object.entries(KINDS)) if (v.source === "core" && v.run) out[k] = v.run;
  return out;
}

/** What each kind queues next, for the worker. */
export function nextKinds(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.next]));
}

/**
 * What a finished step queues for this edit: `next`'s list, except that the cards come after the B-roll when the edit's
 * style names an animation style. An edit in passes (passes.ts) goes from a draft or a B-roll straight to post, so each
 * pass ends in a preview and waits; only a version whose cards pass ran (`done`) goes on to its cards after a B-roll
 * (Make cards again lays the B-roll first). A draft with no picture (a voice recording's) is recorded as having had its
 * B-roll (timeline.ts), so it goes on to it at once: that B-roll is its picture, and the first cut is filed with it.
 * A moment of a long recording is one line with no room for a card (cards/place.ts keeps the last line clear), so an
 * edit of moments never goes to the cards: no AI call and no Mac draw is spent on them. A preview of a cut that waits for
 * its look (`due`, critique.ts) goes to the look, which files it.
 */
export const nextFor = (kind: string, edit: Pick<EditMeta, "style" | "moments">, next: Record<string, string[]>, done: string[] = [], due = false): string[] =>
  kind === "preview" && due
    ? ["critique"]
    : edit.style?.passes && ((kind === "draft" && !done.includes("broll")) || (kind === "broll" && !done.includes("cards")))
    ? ["post"]
    : kind === "broll" && edit.style?.animation && !edit.moments ? ["cards"] : (next[kind] ?? []);

const deviceKinds = (): string[] => Object.keys(KINDS).filter((k) => KINDS[k]!.source === "device");

/**
 * The kinds one device may claim: the ones it declares that are registered as device kinds. A core kind named by a
 * device is ignored, so a device cannot take server work.
 */
export function claimableBy(declared: string[]): string[] {
  return declared.filter((k) => KINDS[k]?.source === "device");
}

/**
 * Takes the oldest queued job whose kind is in `kinds` (or, with "server", any kind no device kind claims), leases it
 * and counts the attempt. Same contract as library/jobs claimJob, which takes any kind. A device passes `by`: only jobs
 * its owner's account queued are taken, and the job records the device, so its beats, done and fail can be checked.
 * `fits`: of the queued jobs, the oldest it accepts (a device takes only a step whose footage it can get at, reach.ts).
 */
export function claimStep(
  db: DatabaseSync,
  kinds: string[] | "server",
  leaseSeconds: number,
  now: number,
  table: JobTable,
  by?: { actor: string; device: string },
  fits?: (job: JobRow) => boolean,
): JobRow | null {
  let where: string;
  let args: (string | number)[];
  if (kinds === "server") {
    const dev = deviceKinds();
    where = dev.length ? `AND kind NOT IN (${dev.map(() => "?").join(", ")})` : "";
    args = dev;
  } else {
    if (kinds.length === 0) return null;
    where = `AND kind IN (${kinds.map(() => "?").join(", ")})`;
    args = kinds;
  }
  if (by) {
    where += " AND actor = ?";
    args.push(by.actor);
  }
  const queued = `SELECT * FROM ${table} WHERE state = 'queued' AND run_after <= ? ${where} ORDER BY id`;
  // ponytail: the first 200 queued are looked at; a longer queue of steps nobody here can read waits its turn
  const id = fits ? (db.prepare(`${queued} LIMIT 200`).all(now, ...args) as unknown as JobRow[]).find(fits)?.id : undefined;
  if (fits && id === undefined) return null;
  return (
    (db
      .prepare(
        `UPDATE ${table} SET state = 'running', lease_until = ?, attempts = attempts + 1, device = ?
         WHERE id = ${fits ? "? AND state = 'queued'" : `(SELECT id FROM (${queued} LIMIT 1))`}
         RETURNING *`,
      )
      .get(now + leaseSeconds * 1000, by?.device ?? null, ...(fits ? [id!] : [now, ...args])) as JobRow | undefined) ?? null
  );
}

/**
 * A device that has gone quiet (not online) loses the steps it holds: they go back in the queue at once, not after the
 * lease runs out. A device kind's attempt that was already used is kept (failed after MAX_ATTEMPTS, as requeueExpired
 * does); a core step a computer ran (the work package) goes back with its try not counted: a laptop that sleeps did not
 * fail it (a crash is reported with fail, which counts). Returns how many steps were released.
 */
export function releaseQuietDevices(db: DatabaseSync, isOnline: (device: string) => boolean): number {
  const held = db.prepare("SELECT DISTINCT device FROM edit_jobs WHERE state = 'running' AND device IS NOT NULL").all() as { device: string }[];
  let released = 0;
  for (const { device } of held) {
    if (isOnline(device)) continue;
    // whose steps these are: their edit lists change (a step back in the queue, or failed)
    const actors = db.prepare("SELECT DISTINCT actor FROM edit_jobs WHERE state = 'running' AND device = ?").all(device) as { actor: string | null }[];
    for (const { actor } of actors) if (actor) announce(actor, "editor");
    const core = coreKinds();
    released += Number(
      db
        .prepare(
          `UPDATE edit_jobs SET state = 'queued', attempts = MAX(attempts - 1, 0), lease_until = NULL, device = NULL
           WHERE state = 'running' AND device = ? AND kind IN (${core.map(() => "?").join(", ")})`,
        )
        .run(device, ...core).changes,
    );
    released += Number(
      db
        .prepare(
          `UPDATE edit_jobs SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
             error = CASE WHEN attempts >= ? THEN 'device went quiet' ELSE error END, lease_until = NULL, device = NULL
           WHERE state = 'running' AND device = ?`,
        )
        .run(MAX_ATTEMPTS, MAX_ATTEMPTS, device).changes,
    );
  }
  return released;
}
