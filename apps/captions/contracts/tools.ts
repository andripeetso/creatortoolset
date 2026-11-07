/**
 * The apps an admin switches on or off per account (Admin → Access). Every app
 * is on unless switched off; admins always have all of them. Listed in the
 * home page's order.
 */
export const TOOLS = [
  "instagram", "workshop",
  "enhance", "captions", "review", "media", "editor",
  "clean", "stories",
  "notes", "guides",
] as const;
export type Tool = (typeof TOOLS)[number];
export const isTool = (t: unknown): t is Tool => TOOLS.includes(t as Tool);

export const TOOL_NAMES: Record<Tool, string> = {
  instagram: "Content Analyzer",
  workshop: "Content Workshop",
  enhance: "Audio Enhancer",
  captions: "Caption Studio",
  review: "Review",
  media: "Media Library",
  editor: "AI Editor",
  clean: "Video Cleaner",
  stories: "Story Splitter",
  notes: "Video Notes",
  guides: "Guide Builder",
};

/** The home page's sections. */
export const TOOL_GROUPS: Record<Tool, string> = {
  instagram: "Ideas",
  workshop: "Ideas",
  enhance: "Make",
  captions: "Make",
  review: "Make",
  media: "Make",
  editor: "Make",
  clean: "Distribute",
  stories: "Distribute",
  notes: "Other tools",
  guides: "Other tools",
};
