import { TRANSCRIBE_KIND, parseTranscribeResult, type DeviceJob, type TranscribeResult } from "../../contracts/devices";
import { DEFAULT_WEIGHT, type Balance, type Device } from "../../contracts/providers";
import { STT_MODELS } from "../../contracts/voice";
import { deviceOf, isOnline, listDevices, setDeviceStt } from "./devices";
import { wakeEditorPolls } from "./mac-claude";

/**
 * Transcripts made with a model downloaded on one of the person's own computers (contracts/devices.ts TRANSCRIBE_KIND):
 * what each computer has and was asked to keep, which computer gets a transcript (the strongest one that is on and has
 * the model), and the transcripts waiting for one. The audio stays a file of the caller's until the computer fetches it;
 * a transcript lives as long as the call that waits for it (in memory, like a cut-out, lib/cutouts.ts).
 */

/** The models a computer can download (STT_MODELS with `computer`). */
export const isComputerModel = (id: string): boolean => STT_MODELS.some((m) => m.id === id && m.computer);
const nameOf = (id: string) => STT_MODELS.find((m) => m.id === id)?.name ?? id;

/** The transcript can't run now: no computer that has its model is on. The library waits and tries again. */
export class ComputerOff extends Error {}

/** The account's computers that run speech models (they declared the kind). */
export const speechComputers = (owner: string): Device[] => listDevices((d) => d.owner === owner && !!d.kinds?.includes(TRANSCRIBE_KIND));
const holds = (d: Device, model: string) => !!d.stt?.held.includes(model);

/**
 * Strongest first: a computer set to Off (load balancing) last, then by its preference, then by graphics memory, then by
 * cores. A Mac reports no graphics card, so a computer with a large one goes first at the same preference.
 * ponytail: graphics memory stands for speed (a CUDA card is 10× a CPU); measure each computer's own pace when two cards differ.
 */
export function strongest(devices: Device[], weights: Balance["weights"]): Device[] {
  const key = (d: Device) => {
    const w = weights[d.id] ?? DEFAULT_WEIGHT;
    return [w > 0 ? 1 : 0, w, d.report?.machine?.gpuMemGb ?? 0, d.report?.machine?.cpus ?? 0];
  };
  return [...devices].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const i = x.findIndex((v, k) => v !== y[k]);
    return i < 0 ? 0 : y[i]! - x[i]!;
  });
}

/**
 * What a computer said in its claim: the models it has and is downloading. Its owner's wishes start as what it has,
 * so a model put there before is never deleted unasked.
 */
export function declareModels(d: Device, held: string[], getting: string[]): void {
  setDeviceStt(d.id, { want: d.stt?.want ?? held, held, getting });
}

/** Whether the models its owner wants differ from what the computer said: then it is hinted, claims, and is told. */
export function modelsOutOfStep(d: Device): boolean {
  const s = d.stt;
  if (!s) return false;
  return s.want.some((m) => !s.held.includes(m) && !s.getting.includes(m)) || s.held.some((m) => !s.want.includes(m));
}

/** Download (keep) or Remove `model` on the account's own computer. The reason it can't, or null. */
export function wantModel(owner: string, id: string, model: string, keep: boolean): string | null {
  const d = deviceOf(id);
  if (d?.owner !== owner || !d.kinds?.includes(TRANSCRIBE_KIND)) return "Not one of your computers that run speech models";
  if (!isComputerModel(model)) return `${model} is not a model a computer downloads`;
  const want = (d.stt?.want ?? d.stt?.held ?? []).filter((m) => m !== model);
  setDeviceStt(id, { held: [], getting: [], ...d.stt, want: keep ? [...want, model] : want });
  void wakeEditorPolls();
  return null;
}

interface Job {
  id: number;
  owner: string;
  model: string;
  languages: string[];
  /** the WAV the computer fetches */
  audio: string;
  /** the computer that claimed it */
  device?: string;
  end: (r: TranscribeResult | Error) => void;
}
const jobs = new Map<number, Job>();
let lastId = 0;
/** How often a waiting transcript checks that a computer for it is still on. */
const CHECK_MS = 15_000;

const onlineHolders = (owner: string, model: string) => speechComputers(owner).filter((d) => holds(d, model) && isOnline(d.id));
const offLine = (model: string) => `Waits for a computer with ${nameOf(model)} to be on`;

/**
 * The words in `audio` (a WAV, 16 kHz mono 16-bit) heard by `model` on one of `owner`'s computers. Rejects with
 * ComputerOff when none that has it is on (now, or while it waits), with the computer's own words when it fails.
 */
export function transcribeOnComputer(owner: string, model: string, languages: string[], audio: string): Promise<TranscribeResult> {
  if (!onlineHolders(owner, model).length) return Promise.reject(new ComputerOff(offLine(model)));
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    // a computer that went off gives its transcript back; with none left that is on, the caller waits and tries again
    const check = setInterval(() => {
      if (j.device && !isOnline(j.device)) {
        j.device = undefined;
        void wakeEditorPolls();
      }
      if (!j.device && !onlineHolders(owner, model).length) end(new ComputerOff(offLine(model)));
    }, CHECK_MS);
    check.unref();
    const end = (r: TranscribeResult | Error) => {
      clearInterval(check);
      jobs.delete(id);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const j: Job = { id, owner, model, languages, audio, end };
    jobs.set(id, j);
    void wakeEditorPolls();
  });
}

/**
 * The oldest waiting transcript this computer gets: one whose model it has, where it is the strongest of the computers
 * that are on and have it (any of them, with load balancing off). It waits for a busy strongest one.
 * ponytail: a second transcript waits for the strongest computer instead of going to the next; spread them when a
 * slower computer would finish sooner than the queue.
 */
function nextFor(d: Device, balance: Balance): Job | undefined {
  for (const j of jobs.values()) {
    if (j.owner !== d.owner || j.device || !holds(d, j.model)) continue;
    if (!balance.on) return j;
    const best = strongest(onlineHolders(d.owner, j.model).concat(isOnline(d.id) ? [] : [d]), balance.weights)[0];
    if (best?.id === d.id) return j;
  }
  return undefined;
}

/** Whether a transcript waits that this computer would be handed now. */
export const transcriptWaits = (d: Device, balance: Balance): boolean => !!nextFor(d, balance);

/** A computer's claim: the transcript it gets, now its own. */
export function claimTranscript(d: Device, balance: Balance): DeviceJob | null {
  const j = nextFor(d, balance);
  if (!j) return null;
  j.device = d.id;
  return { id: j.id, kind: TRANSCRIBE_KIND, editId: "", variant: "", model: j.model, languages: j.languages };
}

/** The audio file of a transcript this computer holds, or null. */
export const heldAudio = (device: string, id: number): string | null => {
  const j = jobs.get(id);
  return j?.device === device ? j.audio : null;
};

/** What the computer sent: words end the transcript, anything else is refused. The reason, "Not found" (not its own), or null. */
export function transcriptSent(device: string, id: number, body: unknown): string | null {
  const j = jobs.get(id);
  if (j?.device !== device) return "Not found";
  const r = parseTranscribeResult(body);
  if (typeof r === "string") return r;
  j.end(r);
  return null;
}

/** The computer could not make it: the transcript fails with its words. False when it is not this computer's. */
export function transcriptFailed(device: string, id: number, why: string): boolean {
  const j = jobs.get(id);
  if (j?.device !== device) return false;
  j.end(new Error(why.slice(0, 500)));
  return true;
}
