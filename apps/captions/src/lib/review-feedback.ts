import { create } from "zustand";

/**
 * Feedback mode (owner, 2026-11-16): beside the chats, a Review video drops its comments column, and the chat's message
 * box can turn into that video's comment box. What is written there is saved as the video's comments, not sent to the
 * chat; the chat reads them (the review tool) when asked to fix them.
 */
interface Feedback {
  /** The open Review video's comments while it offers its box to the chat; null when no such video is on screen. */
  count: number | null;
  /** The person switched the message box to the comment box. Kept while they move between videos. */
  on: boolean;
  /** Where the chat draws the comment box (the Review page portals it there). */
  slot: HTMLElement | null;
}

export const useFeedback = create<Feedback>(() => ({ count: null, on: false, slot: null }));
