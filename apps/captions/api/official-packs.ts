import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { checkPack, type Pack, type PackLevel } from "../contracts/packs";

// In api/ on purpose: from here "../packs" is apps/captions/packs both in the source tree and in the bundle (dist/).
const OFFICIAL_DIR = path.resolve(import.meta.dirname, "../packs");

/** Shipped packs: every apps/captions/packs/*.ctpack.json that passes the checks. Bad files are logged and skipped. */
export interface OfficialPack {
  pack: Pack;
  level: PackLevel;
  publishedAt: number;
}
export function readOfficialPacks(dir = OFFICIAL_DIR): OfficialPack[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ctpack.json")).sort();
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: OfficialPack[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      console.warn(`[packs] ${f}: not JSON, skipped`);
      continue;
    }
    const r = checkPack(raw);
    if (!r.ok || !r.pack) {
      console.warn(`[packs] ${f} skipped: ${r.problems.join("; ")}`);
      continue;
    }
    if (seen.has(r.pack.id)) {
      console.warn(`[packs] ${f}: id ${r.pack.id} already used, skipped`);
      continue;
    }
    seen.add(r.pack.id);
    out.push({ pack: r.pack, level: r.level ?? 0, publishedAt: Math.floor(statSync(file).mtimeMs) });
  }
  return out;
}

