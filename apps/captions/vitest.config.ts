import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

// Test files that run ffmpeg (or the plug-in builder: lib/folder-plugins as its own program, scripts/plugin-build here). Under full-suite
// load they hit the 5 s default timeout, so they run in their own project, after the rest: at most 4 files at once,
// and a 30 s per-test timeout. Add a new ffmpeg test file here.
const ffmpegFiles = [
  "api/assistant.test.ts",
  "api/clean-compare.test.ts",
  "api/clean-edit.test.ts",
  "api/clean-privacy.test.ts",
  "api/clean-timeline.test.ts",
  "api/clean-workspace.test.ts",
  "api/clean.test.ts",
  "api/editor/analyze.test.ts",
  "api/editor/animation-styles.test.ts",
  "api/editor/cards/step.test.ts",
  "api/editor/editor-ui.e2e.test.ts",
  "api/editor/grade.test.ts",
  "api/editor/preview.test.ts",
  "api/editor/sync.test.ts",
  "api/enhance.test.ts",
  "api/lib/clean-comparison.test.ts",
  "api/lib/clean-extended-scores.test.ts",
  "api/lib/clean-fingerprints.test.ts",
  "api/lib/folder-plugins.test.ts",
  "api/library/describe.test.ts",
  "api/library/fingerprint.test.ts",
  "api/library/library-ui.e2e.test.ts",
  "api/library/media/media.test.ts",
  "api/library/search.test.ts",
  "api/library/shares.test.ts",
  "api/library/similar.test.ts",
  "api/library/transcribe.test.ts",
  "api/mcp-tools/notes.test.ts",
  "api/mcp-tools/captions.test.ts",
  "api/review-library.test.ts",
  "api/review.test.ts",
  "scripts/plugin-build.test.mjs",
  "editor-steps/face-refine/plugin.test.ts",
  "editor-steps/voice/plugin.test.ts",
];

const include = [
  "api/**/*.test.ts",
  "api/**/*.spec.ts",
  "contracts/**/*.test.ts",
  "src/**/*.test.ts",
  "src/**/*.test.tsx",
  "scripts/**/*.test.mjs",
  "editor-steps/**/*.test.ts",
];

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@contracts": path.resolve(templateRoot, "contracts"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    globalSetup: "./vitest.tmp.ts",
    projects: [
      {
        extends: true,
        test: { name: "unit", include, exclude: [...configDefaults.exclude, ...ffmpegFiles] },
      },
      {
        extends: true,
        test: { name: "ffmpeg", include: ffmpegFiles, maxWorkers: 4, testTimeout: 30_000, sequence: { groupOrder: 1 } },
      },
    ],
  },
  esbuild: { jsx: "automatic" },
});
