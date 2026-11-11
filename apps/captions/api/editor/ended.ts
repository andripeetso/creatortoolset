import { workEnded } from "../assistant";
import { libraryDb } from "../library/db";
import type { JobRow } from "../library/jobs";
import { readEdit, readStep } from "./store";

/**
 * An edit's run has ended, for the chat it was started from. The worker calls runEnded each time a step moves
 * (worker.ts `moved`): when that step is over and nothing of the edit is queued or running, the edit's running cards
 * get their end and the chat says so once (workEnded says nothing when no card was running, so an edit started on its
 * own page tells nobody). A step that will be tried again is still queued, so only a failure for good ends a run.
 */

/** The answers under "ready". The run has filed each draft's preview in Review already, so the second one opens it there (the page's own button). */
export const READY_CHOICES = ["Show me", "Open in Review"];

type Row = Pick<JobRow, "id" | "kind" | "state" | "error"> & { version_id: string };
const bad = (r: Row) => r.state === "failed" || r.state === "needs_key";

export function runEnded(job: JobRow): void {
  try {
    const vid = job.version_id ?? "";
    const edit = readEdit(vid.slice(0, vid.indexOf(":")));
    if (!edit) return;
    const rows = libraryDb().prepare("SELECT id, version_id, kind, state, error FROM edit_jobs WHERE edit_id = ?").all(edit.id) as unknown as Row[];
    const variantOf = (r: Row) => r.version_id.slice(edit.id.length + 1);
    const row = rows.find((r) => r.id === job.id);
    // still going (claimed, waiting, or queued for another try), or stopped by the person: stopEdit ended the cards
    if (!row || row.state === "queued" || row.state === "running" || row.error === "Stopped") return;
    const who = edit.createdBy;
    const variant = variantOf(row);
    // a draft someone sent to Review: its own card ends when its preview is there, whatever else still runs
    const filed =
      row.kind === "file" && row.state === "done" &&
      workEnded(who, `edit:${edit.id}:review:${variant}`, { status: "done", detail: "In Review", say: `“${edit.name} ${variant}” is in Review.`, choices: READY_CHOICES });
    if (rows.some((r) => r.state === "queued" || r.state === "running")) return;

    let end: Parameters<typeof workEnded>[2] = { status: "done", detail: "Done" };
    if (bad(row)) {
      const why = (row.error ?? "failed").replace(/\s+/g, " ").trim().slice(0, 200);
      const what = `“${variant ? `${edit.name} ${variant}` : edit.name}”`;
      end = { status: "failed", detail: why, say: `${what} ${row.state === "needs_key" ? "needs setup" : "did not finish"}: ${why}`, choices: ["Show me"] };
    } else if (row.kind === "file") {
      // ready = a planned version whose preview is filed and none of whose own steps failed (a file step done before a
      // step above it failed is from an earlier run)
      const planned = (readStep(edit.id, "plan")?.plans ?? []).map((p) => p.name);
      const n = planned.filter((v) => rows.some((r) => variantOf(r) === v && r.kind === "file" && r.state === "done") && !rows.some((r) => variantOf(r) === v && bad(r))).length;
      const all = planned.length;
      const name = `“${edit.name}”`;
      if (n)
        end = {
          status: "done",
          detail: n === all ? "Done" : `${n} of ${all} versions done`,
          say: n < all ? `${n} of ${all} versions of ${name} ${n === 1 ? "is" : "are"} ready.` : n === 1 ? `The first draft of ${name} is ready.` : `${n} versions of ${name} are ready.`,
          choices: READY_CHOICES,
        };
    }
    // said already for the draft that went to Review: the other cards end without a second line
    workEnded(who, `edit:${edit.id}`, filed ? { status: end.status, detail: end.detail } : end);
  } catch (e) {
    console.error("[editor] ending:", e);
  }
}

/** Stop (the person's own press, or the edit going to the trash): the edit's cards end, and nothing is said. */
export function editStopped(editId: string): void {
  const edit = readEdit(editId);
  if (edit) workEnded(edit.createdBy, `edit:${editId}`, { status: "failed", detail: "Stopped" });
}
