import { type ObsidianFormat, setObsidianFormat, setObsidianStatusLabels } from "./export";

/**
 * A test plug-in's vault format, as a plug-in with its own Obsidian vault would set it (setObsidianStatusLabels and
 * setObsidianFormat). The tests that check the vault side install these; the public default is the generic format in export.ts.
 * Property names, status labels and media values below are the fixture's; they are not the public defaults.
 */
export const TEST_PLUGIN_STATUS_LABELS: Record<string, string> = {
  draft: "💡 Idea",
  writing: "✍️ Writing",
  ready: "👍 Ready",
  production: "🎥 Filming",
  editing: "✂️ Editing",
  toPost: "📤 Ready to post",
  published: "✅ Published",
  shelved: "📁 Shelved",
};

export const TEST_PLUGIN_FORMAT: ObsidianFormat = {
  media: { reel: "🎞️ Reel", carousel: "🎪 Carousel" },
  frontmatter: ({ kind, day, status, media }) => [
    ["change", day],
    ["details", kind === "carousel" ? "CAROUSEL" : ""],
    ["selector.Status", status],
    ["selector.Media", media],
  ],
};

/** Installs the test plug-in's status labels and format, as its loader would at boot. */
export function installTestPlugin(): void {
  setObsidianStatusLabels(TEST_PLUGIN_STATUS_LABELS);
  setObsidianFormat(TEST_PLUGIN_FORMAT);
}
