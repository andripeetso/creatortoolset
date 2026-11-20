import { DESIGN_AIDS, DESIGN_LIMITS, DESIGN_SAFE, type DesignGrid, type DesignGuide, type DesignPage, type DesignSafe } from "../../contracts/design";

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const whole = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : undefined);
const COLOR = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A frame's aids as they may be saved (its ruler guides, layout grids and the social apps' covered parts it shows),
 * whoever sent them: whole pixels inside what a frame can be, known kinds only, and none of a list that is empty.
 * They are the designer's own and are never drawn in a saved picture.
 */
export function cleanAids(raw: Record<string, unknown>): Pick<DesignPage, "guides" | "grids" | "safe"> {
  const seen = new Set<string>();
  const guides: DesignGuide[] = [];
  for (const g of Array.isArray(raw.guides) ? raw.guides : []) {
    const at = obj(g) && (g.axis === "x" || g.axis === "y") ? whole(g.at, 0, DESIGN_LIMITS.frameMax) : undefined;
    // one guide a line: the same line twice is one
    if (at === undefined || seen.has(`${g.axis}${at}`) || guides.length >= DESIGN_AIDS.guides) continue;
    seen.add(`${g.axis}${at}`);
    guides.push({ axis: g.axis as DesignGuide["axis"], at });
  }
  const grids: DesignGrid[] = [];
  for (const g of (Array.isArray(raw.grids) ? raw.grids : []).slice(0, DESIGN_AIDS.grids)) {
    if (!obj(g) || (g.kind !== "columns" && g.kind !== "rows" && g.kind !== "grid")) continue;
    const color = typeof g.color === "string" && COLOR.test(g.color.trim()) ? g.color.trim().toLowerCase() : "#ff0000";
    const hidden = g.hidden === true ? { hidden: true as const } : {};
    if (g.kind === "grid") grids.push({ kind: "grid", size: whole(g.size, 1, DESIGN_LIMITS.frameMax) ?? 10, color, ...hidden });
    else grids.push({ kind: g.kind, count: whole(g.count, 1, DESIGN_AIDS.count) ?? 4, gutter: whole(g.gutter, 0, DESIGN_LIMITS.frameMax) ?? 0, margin: whole(g.margin, 0, DESIGN_LIMITS.frameMax) ?? 0, color, ...hidden });
  }
  const safe = DESIGN_SAFE.map((s) => s.id).filter((id): id is DesignSafe => Array.isArray(raw.safe) && raw.safe.includes(id));
  return { ...(guides.length ? { guides } : {}), ...(grids.length ? { grids } : {}), ...(safe.length ? { safe } : {}) };
}
