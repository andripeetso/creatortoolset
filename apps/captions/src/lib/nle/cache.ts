import type { NleItem, NleTimeline } from "./model";

/**
 * The render bar under the ruler: which V1 shots of the timeline as it is now a render takes from the render cache. The
 * server says which ranges of the saved timeline are cached; a shot keeps its green while it, its source, its linked voice
 * (the A1 clip starting with it) and, across a transition, its neighbour are as saved. Its place may change: a ripple
 * moves nothing in its frames, so the cache keeps it.
 */

/** JSON with every object's keys sorted: the same clip reads the same whatever order its fields were set in. */
const stable = (x: unknown): string =>
  JSON.stringify(x, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );

/** A clip as the cache knows it: all of it but its place and the editor's own key, with its source. */
function sig(it: NleItem | undefined, tl: NleTimeline): unknown {
  if (!it) return null;
  const { rec: _rec, _k: _key, ...rest } = it;
  return [rest, tl.sources[it.src] ?? null];
}

const v1 = (tl: NleTimeline) => [...(tl.tracks.V1?.items ?? [])].sort((a, b) => a.rec - b.rec);

/** A V1 shot with what its cached segment was made from. */
function shot(tl: NleTimeline, list: NleItem[], i: number): string {
  const it = list[i]!;
  const next = list[i + 1];
  const voice = tl.tracks.A1?.items.find((a) => a.rec === it.rec);
  return stable([sig(it, tl), sig(voice, tl), it.trans ? sig(list[i - 1], tl) : null, next?.trans ? sig(next, tl) : null]);
}

/** Ranges [rec, len] joined where they touch or overlap. */
function merged(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [r, l] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && r <= last[0] + last[1]) last[1] = Math.max(last[1], r + l - last[0]);
    else out.push([r, l]);
  }
  return out;
}

/** The V1 ranges [rec, len] of `now` that are cached, from `cached`: the cached ranges of the `saved` timeline. */
export function stillCached(now: NleTimeline, saved: NleTimeline, cached: readonly (readonly [number, number])[] | undefined): [number, number][] {
  if (!cached?.length || stable([now.timeline, now.format]) !== stable([saved.timeline, saved.format])) return [];
  const spans = merged(cached);
  const covered = (it: NleItem) => spans.some(([r, l]) => it.rec >= r && it.rec + it.len <= r + l);
  const was = v1(saved);
  const have = new Set(was.flatMap((it, i) => (covered(it) ? [shot(saved, was, i)] : [])));
  const list = v1(now);
  return list.flatMap((it, i) => (have.has(shot(now, list, i)) ? [[it.rec, it.len] as [number, number]] : []));
}
