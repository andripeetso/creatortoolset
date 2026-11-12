import { defineConfig } from "vitest/config";
import base from "../../vitest.config";

// The plug-in's own tests. The app's `pnpm test` doesn't look in plug-in folders; run these from apps/captions with this
// folder at plugins/adobe-enhance:
//   pnpm exec vitest run --config plugins/adobe-enhance/vitest.config.ts
// The app's config gives the @/ and @contracts aliases. adobe-run.test.ts drives Google Chrome against a stand-in of
// Adobe's page, and runs only with ADOBE_E2E=1 (a Chrome window on screen for the sign-in with ADOBE_E2E_WINDOW=1 too).
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: [
      {
        extends: true,
        test: { name: "adobe-enhance", include: ["plugins/adobe-enhance/**/*.test.ts"], maxWorkers: 1, testTimeout: 120_000 },
      },
    ],
  },
});
