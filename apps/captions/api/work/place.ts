/** Item 4B: which place a step goes to (design 5), and what a computer working on a step last said. */
import type { WorkBeat } from "../../contracts/work";

export interface WorkProgress extends WorkBeat {
  /** the computer's name, as Settings → Devices shows it */
  device: string;
  at: number;
}

/** What the computer holding `jobId` last reported, while it holds it. */
export function progressOf(jobId: number): WorkProgress | undefined {
  void jobId;
  return undefined;
}
