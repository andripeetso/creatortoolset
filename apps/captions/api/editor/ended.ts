import type { AssistantMedia } from "../../contracts/assistant";
import { draftName } from "../../contracts/editor";
import { workEnded } from "../assistant";
import { libraryDb } from "../library/db";
import { emitEvent } from "../lib/events";
import type { JobRow } from "../library/jobs";
import { nextPass, PASS_WORD } from "./passes";
import { saidOf, saidWords } from "./preview";
import { readDraft, readEdit, readStep, type EditMeta } from "./store";

/**
 * An edit's run has ended, for the chat it was started from. The worker calls runEnded each time a step moves
 * (worker.ts `moved`): when that step is over and nothing of the edit is queued or running, the edit's running cards
 * get their end and the chat says so once (workEnded says nothing when no card was running, so an edit started on its
 * own page tells nobody). A step that will be tried again is still queued, so only a failure for good ends a run.
 */

/** Several versions ready at once: "Draft 2 of “X”" when they are all that draft; each version is its own Review video with its own numbering, so mixed drafts name none. */
const headline = (drafts: number[], name: string) => (new Set(drafts).size === 1 ? `${draftName(drafts[0]!)} of ${name}` : name);

/**
 * A draft's cut in Review, as the ready line plays it in the chat with Approve and Request changes under it (AssistantMedia
 * `cut`): no AI turn to watch it. `next`: the pass approving it starts (passes.ts), as filing named it on the version.
 */
export function cutMedia(edit: EditMeta, variant: string): AssistantMedia | null {
  const p = readStep(edit.id, "review")?.[variant];
  if (!p) return null;
  const pass = nextPass(edit, variant);
  const api = `/api/review/assets/${p.assetId}/v/${p.n}`;
  return {
    id: `review:${p.assetId}:${p.n}`,
    kind: "video",
    // "Handstand basics · Draft 2", as the line says it
    title: `${edit.name} · ${cutName(edit, variant)}`,
    src: `${api}/play`,
    poster: `${api}/thumb`,
    href: `/review/${p.assetId}?v=${p.n}`,
    cut: { asset: p.assetId, n: p.n, ...(pass ? { next: PASS_WORD[pass] } : {}) },
  };
}
/**
 * A version's newest cut by its name (draftName): its Review version is the draft, and with several planned its letter
 * is the Version (a moment of a long recording goes by its title instead).
 */
export function cutName(edit: EditMeta, variant: string): string {
  const n = readStep(edit.id, "review")?.[variant]?.n ?? 1;
  const plans = readStep(edit.id, "plan")?.plans ?? [];
  const i = plans.findIndex((x) => x.name === variant);
  if (edit.moments) return `${plans[i]?.title ? `${plans[i]!.title} · ` : ""}${draftName(n)}`;
  return draftName(n, plans.length > 1 && i >= 0 ? String.fromCharCode(65 + i) : undefined);
}

/** The cuts a line plays (workEnded keeps this many). */
const MAX_CUTS = 4;
const cutsOf = (edit: EditMeta, variants: string[]) => variants.slice(0, MAX_CUTS).flatMap((v) => cutMedia(edit, v) ?? []);

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
      workEnded(who, `edit:${edit.id}:review:${variant}`, { status: "done", detail: "In Review", say: `${cutName(edit, variant)} of “${edit.name}” is in Review.`, media: cutsOf(edit, [variant]) });
    if (rows.some((r) => r.state === "queued" || r.state === "running")) return;

    let end: Parameters<typeof workEnded>[2] = { status: "done", detail: "Done" };
    let waits: string | null = null; // the line the person's phones get, when the run left them something
    if (bad(row)) {
      const why = (row.error ?? "failed").replace(/\s+/g, " ").trim().slice(0, 200);
      const what = `“${variant ? `${edit.name} ${variant}` : edit.name}”`;
      end = { status: "failed", detail: why, say: `${what} ${row.state === "needs_key" ? "needs setup" : "did not finish"}: ${why}` };
      waits = `${row.state === "needs_key" ? "Needs setup" : "Did not finish"}: ${why}`;
    } else if (row.kind === "file") {
      // ready = a planned version whose preview is filed and none of whose own steps failed (a file step done before a
      // step above it failed is from an earlier run)
      const planned = (readStep(edit.id, "plan")?.plans ?? []).map((p) => p.name);
      const ready = planned.filter((v) => rows.some((r) => variantOf(r) === v && r.kind === "file" && r.state === "done") && !rows.some((r) => variantOf(r) === v && bad(r)));
      const n = ready.length;
      // what the look before Review left on each, in words (only the chat says it)
      const left = ready.map((v) => {
        const d = readDraft(edit.id, v);
        const w = d ? saidWords(saidOf(d)) : "";
        return w && n > 1 ? `${cutName(edit, v)}: ${w}` : w;
      }).filter(Boolean).join(" ");
      const all = planned.length;
      const name = `“${edit.name}”`;
      if (n) waits = n === all ? "Ready for review" : `${n} of ${all} versions ready for review`;
      if (n)
        end = {
          status: "done",
          detail: n === all ? "Done" : `${n} of ${all} versions done`,
          say: (n < all ? `${n} of ${all} versions of ${name} ${n === 1 ? "is" : "are"} ready.` : n === 1 ? `${cutName(edit, ready[0]!)} of ${name} is ready.` : `${headline(ready.map((v) => readStep(edit.id, "review")?.[v]?.n ?? 1), name)} is ready in ${n} versions.`) + (left ? ` ${left}` : "") + (n > MAX_CUTS ? ` The chat plays ${MAX_CUTS}; the other ${n - MAX_CUTS} are in Review.` : ""),
          media: cutsOf(edit, ready),
          redone: n === all,
        };
    }
    // the person's phones hear of a run that failed or left cuts in Review, wherever it was started
    if (waits) emitEvent("waiting", { owner: who, kind: end.status === "failed" ? "failed" : "review", title: edit.name ?? "Edit", headline: waits, path: `/editor/${edit.id}`, ...(edit.projectId ? { workspace: edit.projectId } : {}) });
    // said already for the draft that went to Review: the other cards end without a second line
    workEnded(who, `edit:${edit.id}`, filed ? { status: end.status, detail: end.detail, redone: end.redone } : end);
  } catch (e) {
    console.error("[editor] ending:", e);
  }
}

/** Stop (the person's own press, or the edit going to the trash): the edit's cards end, and nothing is said. */
export function editStopped(editId: string): void {
  const edit = readEdit(editId);
  if (edit) workEnded(edit.createdBy, `edit:${editId}`, { status: "stopped", detail: "Stopped" });
}

// an edit's cards run while a step of it is queued or running (assistant.ts sweepWork). An edit this store doesn't
// have is another editor's (a plug-in's own AI Editor answers for its edits).
void import("../assistant").then(({ checkWork }) => checkWork("edit", (id) => {
  const edit = readEdit(id.split(":")[1] ?? "");
  if (!edit) return undefined;
  const rows = libraryDb().prepare("SELECT id, version_id, kind, state, error FROM edit_jobs WHERE edit_id = ?").all(edit.id) as unknown as Row[];
  if (rows.some((r) => r.state === "queued" || r.state === "running")) return null;
  if (rows.some((r) => r.error === "Stopped")) return { status: "stopped", detail: "Stopped" };
  const failed = rows.find(bad);
  return failed ? { status: "failed", detail: (failed.error ?? "failed").replace(/\s+/g, " ").trim().slice(0, 200) } : { status: "done", detail: "Done" };
}));
