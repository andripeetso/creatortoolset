/**
 * Choosing faces by the person's own words: the AI sees one picture per face and answers with the ids that match. Shared by
 * the AI Editor's Blur faces step (editor-steps/face-blur) and the Face Blur tool (editor-steps/blur-faces).
 */

/** The rule every face question carries: match by what is visible, never say who someone is. */
export const NEVER_IDENTIFY =
  "Never identify anyone: don't name, guess or describe who a person is. A picture that shows no face is not blurred. " +
  'Answer with JSON only: {"blur": ["T1", ...]}, the ids to blur; an empty list when none match.';

/** The Face Blur tool's question: one picture per face (up to three moments side by side) and a line about each. */
export const FACE_PICK_SYSTEM =
  "You choose which faces in a photo or video get blurred, following the person's instruction. Each picture is one face: the same face at up to three moments, side by side, " +
  "with a line saying where it is in the frame, how big and for how long it is seen. Match only what the instruction asks, from what is visible and from those lines: where a face is, " +
  "how big, whether the person looks younger or older. " +
  NEVER_IDENTIFY;

/** The ids the AI's answer names, of those asked about ({"blur": ["T1", …]}, also inside other text). */
export function chosenIn(text: string, ids: string[]): Set<string> {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("The AI's answer had no JSON");
  const blur = (JSON.parse(m[0]) as { blur?: unknown }).blur;
  if (!Array.isArray(blur)) throw new Error('The AI\'s answer had no "blur" list');
  return new Set(blur.map(String).filter((id) => ids.includes(id)));
}
