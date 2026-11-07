// The checks a pack goes through on install and publish (contracts/packs.ts), for people making one by hand.
//   pnpm --filter @creator-toolset/captions pack:check my-pack.ctpack.json [more.ctpack.json …]
import { readFileSync } from "node:fs";
import { checkPack, PACK_SLOTS } from "../contracts/packs.ts";

let failed = false;
for (const file of process.argv.slice(2)) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    console.log(`✗ ${file}: not JSON (${(e as Error).message})`);
    failed = true;
    continue;
  }
  const r = checkPack(raw);
  if (!r.ok) {
    failed = true;
    console.log(`✗ ${file}\n${r.problems.map((p) => `  - ${p}`).join("\n")}`);
    continue;
  }
  const p = r.pack!;
  const parts = [
    ...Object.keys(p.instructions ?? {}).map((s) => `instructions for ${PACK_SLOTS[s as keyof typeof PACK_SLOTS]}`),
    p.frameworks?.length && `${p.frameworks.length} frameworks`,
    p.captionStyles?.length && `${p.captionStyles.length} caption styles`,
    p.designSystems?.length && `${p.designSystems.length} design systems`,
  ].filter(Boolean);
  console.log(`✓ ${file}: ${p.name} ${p.version}, level ${r.level}${r.level ? " (has drawing code)" : ""}\n  ${parts.join("; ")}`);
}
if (!process.argv[2]) console.log("usage: pack:check <file.ctpack.json> …");
process.exit(failed || !process.argv[2] ? 1 : 0);
