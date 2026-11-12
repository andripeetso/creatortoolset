/**
 * The AI Editor's post-processing steps: plug-ins that change the footage a draft plays (the voice, the colour, the
 * faces). Each step makes copies of the source files it changes, and the preview and the exported timeline play those
 * copies. Settings → Tools → AI Editor lists the steps that are loaded. The plug-ins the team makes come with the app as folders
 * (apps/captions/editor-steps/<folder>: the steps, and others such as an Audio Enhancer engine); Community lists
 * them too, each under the Home tool its plugin.ts names (`kind`), and the person downloads one there.
 *
 *   GET  /api/edit-steps                → StepsView
 *   PUT  /api/edit-steps/:id            { use?: boolean, values?: Record<string, string> } → StepsView
 *   POST /api/edit-steps/add/:folder    copies the plug-in's folder into the Mac app's plug-ins folder → { folder }
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
 * A row in Settings → Tools → AI Editor (only "on" rows) and Community, each in its tool's section (all). state: "add" = comes with the app, not in
 * the plug-ins folder yet; "off" = in the folder, not switched on (or not loaded since); "on" = a loaded step, so new edits
 * can use it; "loaded" = a plug-in that comes with the app, loaded, and adds no AI Editor step (Community: Installed).
 */
export interface StepRow extends StepInfo {
  state: "add" | "off" | "on" | "loaded";
  /** its folder name in the plug-ins folder (add, off and loaded), for the Mac app's switch */
  folder?: string;
  /** the Home tool it adds to, as its plugin.ts says (add, off and loaded; a HomeTile id, contracts/tools.ts): Community's heading */
  kind?: string;
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
