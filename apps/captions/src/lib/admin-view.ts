import { create } from "zustand";
import { flushPendingSave, loadSession } from "./persist";
import { useStudio } from "./store";

export interface AdminCaptionView {
  projectId: string;
  owner: string;
  /** The admin's own project that was open before entering this view. */
  returnProjectId: string | null;
}

interface AdminViewState {
  caption: AdminCaptionView | null;
  beginCaptionView: (view: AdminCaptionView) => void;
  clearCaptionView: () => void;
}

/**
 * Foreign Caption Studio projects are an explicit temporary admin view.
 * Keeping this separate prevents another user's project from silently
 * becoming the admin's normal workspace.
 */
export const useAdminView = create<AdminViewState>((set) => ({
  caption: null,
  beginCaptionView: (caption) => set({ caption }),
  clearCaptionView: () => set({ caption: null }),
}));

/**
 * Save the foreign project, then restore the admin's prior project. If
 * there was no prior project (or it was deleted), return to their list.
 */
export async function returnToOwnCaptionView(): Promise<void> {
  const view = useAdminView.getState().caption;
  if (!view) return;

  await flushPendingSave();
  let restored = false;
  if (view.returnProjectId) {
    restored = await loadSession(view.returnProjectId).catch(() => false);
  }
  if (!restored) useStudio.getState().reset();
  useAdminView.getState().clearCaptionView();
}

export function isAdminForeignView(
  me: { role: string; username: string } | null | undefined,
  owner: string | null | undefined,
): owner is string {
  return Boolean(me && me.role === "admin" && owner && owner !== me.username);
}
