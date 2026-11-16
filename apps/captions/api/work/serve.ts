/** Item 4C: the server side of a computer's AI calls and server reads, run as the held job's account. */
import type { JobRow } from "../library/jobs";

export async function serveAi(job: JobRow, body: unknown): Promise<unknown> {
  void job, body;
  throw new Error("serveAi: not built yet (4C)");
}

/** A named server read (an allow-list: workspace context, styles, packs, skills, grade); unknown names are refused. */
export async function serveCall(job: JobRow, fn: string, args: unknown[]): Promise<unknown> {
  void job, fn, args;
  throw new Error("serveCall: not built yet (4C)");
}
