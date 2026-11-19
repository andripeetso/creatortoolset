// Prints what the one-time Media Library migration (UNIFIED-PRD §4.6) would change in DATA_DIR. Writes nothing.
// This repo has no tsx, so bundle it the way the build bundles boot.ts, then run the bundle:
//   npx esbuild scripts/library-migrate-dry-run.ts --bundle --platform=node --format=esm --outfile=<scratch>/dry-run.mjs
//   DATA_DIR=<a copy of the data folder> node <scratch>/dry-run.mjs
// Use a copy: opening library.db applies any pending schema migration, as the server does at boot.
import { migrateOnce } from "../api/library/migrate";

const r = await migrateOnce({ dryRun: true });
if (r.skipped) console.log(`skipped: ${r.skipped}`);
for (const c of r.changes) console.log(`${c.libraryId}\t${c.field}\t${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
for (const o of r.outside) console.log(`OUTSIDE\t${o.libraryId}\t${o.device}\t${o.path}`);
for (const n of r.notes) console.log(`NOTE\t${n}`);
console.log(`${r.changes.length} changes, ${r.outside.length} outside, ${r.notes.length} notes; nothing written`);
process.exit(0);
