/** Item 4A: the package a computer gets for a step (design 2.2), and the edit-folder files it may fetch. */
import type { JobRow } from "../library/jobs";
import type { WorkPackage } from "../../contracts/work";

/** The package for `job`, claimed by `device`; keeps the server's copy at $DATA_DIR/work/<jobId>.json for the merge. */
export async function buildPackage(job: JobRow, device: { id: string; owner: string }): Promise<WorkPackage> {
  void job, device;
  throw new Error("buildPackage: not built yet (4A)");
}

/** The absolute path of an edit-folder file the package names, else null. */
export function ownFile(jobId: number, rel: string): string | null {
  void jobId, rel;
  throw new Error("ownFile: not built yet (4A)");
}
