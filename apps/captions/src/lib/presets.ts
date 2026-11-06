import { create } from "zustand";
import type { CaptionStyle, TextOverlay } from "./types";

/**
 * Server-stored custom presets. Admin-created presets are global (and
 * shadow same-named built-ins); user-created ones are account-private.
 */

export interface ServerPreset {
  id: string;
  name: string;
  kind: "caption" | "text";
  scope: "global" | "user";
  owner: string;
  style: Record<string, unknown>;
  createdAt: number;
}

/** Style fields a text preset captures (not timing/position). */
export type TextPresetPatch = Partial<
  Pick<
    TextOverlay,
    | "fontFamily"
    | "color"
    | "outlineColor"
    | "outlineWidth"
    | "shadowDepth"
    | "boxEnabled"
    | "boxColor"
    | "sizePct"
  >
>;

interface PresetsState {
  presets: ServerPreset[];
  loaded: boolean;
  refresh: () => Promise<void>;
  save: (
    name: string,
    kind: "caption" | "text",
    style: CaptionStyle | TextPresetPatch
  ) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

export const usePresets = create<PresetsState>((set, get) => ({
  presets: [],
  loaded: false,

  refresh: async () => {
    try {
      const res = await fetch("/api/presets");
      if (!res.ok) return;
      set({ presets: await res.json(), loaded: true });
    } catch {
      /* offline — keep whatever we have */
    }
  },

  save: async (name, kind, style) => {
    const res = await fetch("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, kind, style }),
    }).catch(() => null);
    if (!res?.ok) return false;
    await get().refresh();
    return true;
  },

  remove: async (id) => {
    await fetch(`/api/presets/${id}`, { method: "DELETE" }).catch(() => {});
    await get().refresh();
  },
}));
