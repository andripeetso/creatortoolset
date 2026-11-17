/**
 * Sound effect types. A sound in the Media Library's Sound effects folder carries one of these as a tag (the tag is the
 * type's own name), from its file name and length (api/library/sfx.ts), and the editor places them by type.
 */
export const SFX_TYPES = ["whoosh", "swipe", "pop", "click", "hit", "riser", "ding", "glitch", "typing", "camera", "paper", "notification", "transition"] as const;
export type SfxType = (typeof SFX_TYPES)[number];

/** One sound of the shipped CC0 catalog (public/sfx/manifest.json). `file` is relative to public/sfx. */
export interface SfxSound {
  file: string;
  type: SfxType;
  title: string;
  pack: string;
  source: string;
  license: string;
  author: string;
  seconds: number;
  sha256: string;
  starter: boolean;
}

export interface SfxManifest {
  packs: { name: string; source: string; license: string; licenseFile: string }[];
  sounds: SfxSound[];
}
