// The 11-19 setup correction (api/library/setup-correction.ts): which libraries the migration marked set up only because
// of a folder row shared with every workspace. A dry run unless --write. This repo has no tsx, so bundle it the way the
// build bundles boot.ts, into the app's own dist/ (so its packages resolve from the app's node_modules), and run it from
// the app folder against the server's data folder. Nothing needs stopping: it reads, and with --write clears only setupAt.
//   npx esbuild scripts/library-setup-correction.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/library-setup-correction.mjs
//   DATA_DIR=<the data folder> node dist/library-setup-correction.mjs            (dry run)
//   DATA_DIR=<the data folder> node dist/library-setup-correction.mjs --write    (after the list is approved)
//   --keep <id>[,<id>…]  keeps those libraries whatever the checks say
// The server's plug-ins are loaded (api/plugins.gen.ts, as boot loads them) so a workspace a plug-in serves is kept. A
// plug-in may answer that only for the account's current workspace (a footage catalog does): pass its library in --keep.
import { Hono } from "hono";
import { correctSetups } from "../api/library/setup-correction";
import { mountPlugins } from "../api/lib/plugin";
import { serverPlugins } from "../api/plugins.gen";

mountPlugins(new Hono(), serverPlugins);
const write = process.argv.includes("--write");
const at = process.argv.indexOf("--keep");
const keep = at >= 0 ? (process.argv[at + 1] ?? "").split(",").filter(Boolean) : [];
const { stamp, rows } = await correctSetups({ write, keep });
console.log(`migration stamp: ${stamp ?? "(never migrated)"}; plug-ins: ${serverPlugins.map((p) => p.id).join(", ") || "none"}`);
console.log(["id", "projectId", "workspace (id)", "setupAt", "clips", "ownFolders", "action"].join("\t"));
for (const r of rows) console.log([r.id, r.projectId ?? "-", r.ws ? `${r.workspace ?? "?"} (${r.ws})` : "-", r.setupAt ?? "-", r.clips, r.ownFolders, r.action].join("\t"));
const n = rows.filter((r) => r.action === "clear").length;
console.log(write ? `${n} setupAt cleared` : `${n} would be cleared; nothing written (run with --write)`);
process.exit(0);
