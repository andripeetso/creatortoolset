import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { EditStepChoice } from "../../contracts/editor-steps";
import type { Timeline } from "../../contracts/editor";
import { pluginEditorSteps, type EditorStep } from "../lib/plugin";
import { localFiles } from "./preview";
import { editDir, readDraft, readStep, saveDraft, saveStep } from "./store";
import type { StepContext } from "./engine";

/**
 * The post step (one version): the post-processing steps the edit was made with (Edit.steps, from Settings → AI
 * Editor) run in order on the files the draft plays, each on the copies the one before made. What they made is kept
 * per version (post.json: source version id → file), and postFiles (store.ts) hands those copies to the preview and the export.
 * A step the edit uses but this app no longer has is skipped and named in the draft's notes.
 */

/** Notes this step writes start with this, so a rerun replaces them. */
export const POST_NOTE = "Post-processing: ";

export interface PostResult {
  files: Record<string, string>;
  notes: string[];
}

/** Runs the chosen steps in the order the app lists them; `base` is every source's own file. */
export async function runSteps(
  chosen: EditStepChoice[],
  steps: EditorStep[],
  input: { edit: { id: string; name: string; createdBy: string }; variant: string; timeline: Timeline; base: Record<string, string>; workRoot: string; signal: AbortSignal },
): Promise<PostResult> {
  const files: Record<string, string> = {};
  const notes: string[] = [];
  for (const c of chosen) if (!steps.some((s) => s.id === c.id)) notes.push(`${POST_NOTE}${c.id} is not switched on in this app, so it was skipped`);
  for (const st of steps) {
    const c = chosen.find((x) => x.id === st.id);
    if (!c || input.signal.aborted) continue;
    const workDir = path.join(input.workRoot, st.id);
    await mkdir(workDir, { recursive: true });
    const made = await st.run({ edit: input.edit, variant: input.variant, files: { ...input.base, ...files }, timeline: input.timeline, values: c.values, workDir, signal: input.signal });
    for (const [k, f] of Object.entries(made)) if (k in input.timeline.sources) files[k] = f;
  }
  return { files, notes };
}

/**
 * Keeps one copy per source in a version's post folder: the one that plays. An earlier step's copy (a later step made its
 * own from it) and the copies of an older draft of this version go, so a ten-minute video holds one post copy, not one
 * per step (about 1.4 GB a minute in ProRes). The edit's folder goes whole when the edit leaves the trash (purgeEdits).
 */
export async function prune(root: string, keep: Set<string>): Promise<void> {
  const all = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of all) {
    const file = path.join(e.parentPath, e.name);
    if (e.isFile() && !keep.has(file)) await unlink(file).catch(() => {});
  }
}

export async function postStep({ edit, variant, signal }: StepContext): Promise<void> {
  const d = readDraft(edit.id, variant);
  if (!d) throw new Error(`Draft ${variant || "the versions"} first`);
  const chosen = edit.steps ?? [];
  const result = chosen.length
    ? await runSteps(chosen, pluginEditorSteps(), {
        edit: { id: edit.id, name: edit.name, createdBy: edit.createdBy },
        variant,
        timeline: d.timeline,
        base: await localFiles(d.timeline),
        workRoot: path.join(editDir(edit.id), "post", variant || "_"),
        signal,
      })
    : { files: {}, notes: [] };
  if (signal.aborted) return;
  await prune(path.join(editDir(edit.id), "post", variant || "_"), new Set(Object.values(result.files)));
  await saveStep(edit.id, "post", { ...readStep(edit.id, "post"), [variant]: result });
  const notes = [...d.notes.filter((n) => !n.startsWith(POST_NOTE)), ...result.notes];
  if (notes.join("\n") !== d.notes.join("\n")) await saveDraft(edit.id, variant, { ...d, notes });
}
