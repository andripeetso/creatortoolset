/**
 * The AI Editor's post-processing steps: plug-ins that change the footage a draft plays (the voice, the colour, the
 * faces). Each step makes copies of the source files it changes, and the preview and the exported timeline play those
 * copies. Settings → AI Editor lists every step this app has: the ones loaded, and the ones that come with the app as a
 * plug-in folder (apps/captions/editor-steps/<folder>) that the person turns on.
 *
 *   GET  /api/edit-steps                → StepsView
 *   PUT  /api/edit-steps/:id            { use?: boolean, values?: Record<string, string> } → StepsView
 *   POST /api/edit-steps/add/:folder    copies the step's folder into the Mac app's plug-ins folder → { folder }
 *       (only on the Mac app's own server; the person then switches it on in the Mac app's own alert)
 *
 * A new edit records the steps in use when it is made (Edit.steps), with their values, and keeps them.
 */

/** One setting of a step, shown under its row while it is in use. */
export interface StepOption {
  id: string;
  label: string;
  kind: "text" | "choice";
  choices?: { value: string; label: string }[];
  placeholder?: string;
  default: string;
}

/** What a step is, as its plug-in declares it. `order`: steps run lowest first (colour, then faces, then the voice). */
export interface StepInfo {
  id: string;
  title: string;
  about: string;
  order?: number;
  options?: StepOption[];
}

/**
 * A row in Settings → AI Editor. state: "add" = comes with the app, not in the plug-ins folder yet; "off" = in the
 * folder, not switched on (or not loaded since); "on" = loaded, so new edits can use it.
 */
export interface StepRow extends StepInfo {
  state: "add" | "off" | "on";
  /** its folder name in the plug-ins folder (add and off), for the Mac app's switch */
  folder?: string;
  /** new edits use it (only a step that is on) */
  use: boolean;
  /** the person's values for its options, the defaults filled in */
  values: Record<string, string>;
}

export interface StepsView {
  steps: StepRow[];
  /** this server can put a step's folder in place (the Mac app's own server) */
  canAdd: boolean;
}

/** A step an edit uses, with the values it was made with. */
export interface EditStepChoice {
  id: string;
  values: Record<string, string>;
}
