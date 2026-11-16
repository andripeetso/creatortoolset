import { announce } from "../lib/sync";
import { onComputer } from "../work/on-computer";

/**
 * What a running step is doing now, in one line ("Face refinement: setting up its face tools, the first time only"),
 * shown beside the job on the edit page (EditJob.line). Kept in memory for the running job only: a restart ends the job
 * anyway, and a finished one says what it did in its notes.
 */
const lines = new Map<number, string>();

export function sayFor(job: { id: number; actor: string | null }, text: string | null): void {
  // on a computer the line goes up with the next beat (work/on-computer.ts)
  if (onComputer.on) return onComputer.server!.say(text?.slice(0, 200) ?? "");
  if (text) lines.set(job.id, text.slice(0, 200));
  else lines.delete(job.id);
  if (job.actor) announce(job.actor, "editor");
}

export const lineOf = (jobId: number): string | undefined => lines.get(jobId);
