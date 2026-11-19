// The 11-19 setup correction (api/library/setup-correction.ts): which libraries the migration marked set up only because
// of a folder row shared with every workspace. A dry run unless --write. This repo has no tsx, so bundle it the way the
// build bundles boot.ts, then run the bundle against the server's data folder (stop nothing; it reads and, with --write,
// clears only setupAt):
//   npx esbuild scripts/library-setup-correction.ts --bundle --platform=node --format=esm --packages=external --outfile=<scratch>/correction.mjs
//   DATA_DIR=<the data folder> node <scratch>/correction.mjs            (dry run)
//   DATA_DIR=<the data folder> node <scratch>/correction.mjs --write    (after the list is approved)
import { correctSetups } from "../api/library/setup-correction";

const write = process.argv.includes("--write");
const { stamp, rows } = await correctSetups({ write });
console.log(`migration stamp: ${stamp ?? "(never migrated)"}`);
console.log(["id", "projectId", "workspace", "setupAt", "clips", "ownFolders", "action"].join("\t"));
for (const r of rows) console.log([r.id, r.projectId ?? "-", r.workspace ?? "-", r.setupAt ?? "-", r.clips, r.ownFolders, r.action].join("\t"));
const n = rows.filter((r) => r.action === "clear").length;
console.log(write ? `${n} setupAt cleared` : `${n} would be cleared; nothing written (run with --write)`);
process.exit(0);
