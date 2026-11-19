/**
 * What is being dragged toward the timeline right now. A browser hides a drag's data until the drop, so whoever starts
 * a drag (the Media Pool, the Library bin, the source viewer) sets this on dragstart and clears it on dragend; the
 * timeline draws where it would land from it.
 */
export interface Dragged {
  name: string;
  /** the length it would be laid at (the marked part of the source), null while unknown */
  seconds: number | null;
  picture: boolean;
  sound: boolean;
}

export const dragging: { current: Dragged | null } = { current: null };
