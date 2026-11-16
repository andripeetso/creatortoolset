/** Item 4A: taking a computer's result back (design 2.3). */
import type { Readable } from "node:stream";
import type { WorkResult } from "../../contracts/work";

/** Streams one result file into editor/<editId>/.incoming/<jobId>/ when `rel` is allowed; false when it is not. */
export async function acceptUpload(jobId: number, deviceId: string, rel: string, body: Readable): Promise<boolean> {
  void jobId, deviceId, rel, body;
  throw new Error("acceptUpload: not built yet (4A)");
}

/** Applies a result while `deviceId` still holds the step; false (nothing applied) when it does not. */
export async function applyResult(jobId: number, deviceId: string, r: WorkResult): Promise<boolean> {
  void jobId, deviceId, r;
  throw new Error("applyResult: not built yet (4A)");
}
