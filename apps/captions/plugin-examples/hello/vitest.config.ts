import { defineConfig } from "vitest/config";

// The app's own tests don't look in plug-in folders. Run this plug-in's from apps/captions:
//   pnpm exec vitest run --root plugins/hello
export default defineConfig({ root: import.meta.dirname, test: { environment: "node", include: ["**/*.test.ts"] } });
