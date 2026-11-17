import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// One setting, one section: a section title is written in one file only. A second file with the same <Section title>
// is how one page ended up with two "Load balancing" sections (the app's card, then a plug-in's with only its switch).
// Add rows to the section that exists instead. The plug-ins are read too when they sit in ./plugins (a plug-in's own
// suite imports this file).
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const files = ["src", "plugins"]
  .filter((d) => existsSync(path.join(app, d)))
  .flatMap((d) => readdirSync(path.join(app, d), { recursive: true }).map((f) => path.join(d, String(f))))
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test.") && !f.includes("node_modules"));

/** The same title in more than one file, each on a page of its own (or one standing in for the other). Every file is listed. */
const ALLOWED: Record<string, string[]> = {
  // Settings → Tools, Community (catalog, installed) and the hosted admin board
  Packs: ["plugins/hosted/web/AdminBoard.tsx", "src/components/community/CatalogViews.tsx", "src/components/community/PacksInstalled.tsx", "src/components/settings/ToolsSection.tsx"],
  // Settings → Memory, and a plug-in's own page
  Workspaces: ["src/components/settings/MemorySection.tsx", "src/components/settings/PluginWorkspaces.tsx"],
  // the studio Editor's design page, and Settings → Sound effects
  Sources: ["plugins/baby-acrobatics/web/pages/EditorDesignPage.tsx", "src/components/settings/SoundEffectsSection.tsx"],
  // Community: installed, and the catalog
  "Plug-ins": ["src/components/community/PacksInstalled.tsx", "src/components/community/PluginsCatalog.tsx"],
  // Settings → Appearance, and Settings → Media Library
  "Media Library": ["src/components/settings/AppearanceSection.tsx", "src/components/settings/MediaLibrarySection.tsx"],
  // the studio's Folders screen replaces the app's (replacementFor "storage"): never both
  Folders: ["plugins/baby-acrobatics/web/EditorStorage.tsx", "src/components/settings/FoldersSection.tsx"],
  // the Video Cleaner's own page, and a workspace's page
  Access: ["plugins/video-cleaner/web/CleanerAccess.tsx", "src/components/settings/WorkspaceSection.tsx"],
  // a workspace's page, and the hosted admin board
  Accounts: ["plugins/hosted/web/AdminBoard.tsx", "src/components/settings/WorkspaceSection.tsx"],
  // Settings → Workspace: the form's section, or (no workspace yet) the empty one in its place, never both
  Details: ["src/components/settings/WorkspaceDetailsSection.tsx", "src/components/workshop/ProjectForm.tsx"],
};

describe("a section title is written in one file", () => {
  it("no two files make a section of the same name (add rows to the one that exists)", () => {
    const byTitle = new Map<string, Set<string>>();
    for (const f of files)
      for (const m of readFileSync(path.join(app, f), "utf8").matchAll(/<Section\b[^>]*?\btitle="([^"]+)"/g))
        byTitle.set(m[1]!, (byTitle.get(m[1]!) ?? new Set()).add(f.split(path.sep).join("/")));
    const twice = [...byTitle]
      .filter(([title, at]) => at.size > 1 && ![...at].every((f) => ALLOWED[title]?.includes(f)))
      .map(([title, at]) => `${title}: ${[...at].join(", ")}`);
    expect(twice).toEqual([]);
  });

  it("the check reads the files (a moved folder would pass it silently)", () => {
    expect(files.some((f) => f.endsWith("ServerWorkSection.tsx"))).toBe(true);
  });
});
