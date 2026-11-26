import { Session } from "node:inspector/promises";
import path from "node:path";

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] };

/** Where the server's own thread spends its time, for an admin to find what keeps it busy (GET /api/admin/cpu-profile). */
export interface CpuProfile {
  ms: number;
  /** Share of the samples where the thread had nothing to do: near 0 means it is pegged. */
  idle: number;
  /** The busiest call paths (the function, then who called it), each with its share of the samples. */
  top: { share: number; path: string[] }[];
}

const frame = (n: Node) => `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url ? `${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber + 1}` : ""}`.trim();

/** Samples this process's own thread for `ms` (an in-process session: no port is opened) and sums the time by call path. */
export async function cpuProfile(ms: number, depth = 8, count = 20): Promise<CpuProfile> {
  const s = new Session();
  s.connect();
  try {
    await s.post("Profiler.enable");
    await s.post("Profiler.start");
    await new Promise((done) => setTimeout(done, ms));
    const { profile } = (await s.post("Profiler.stop")) as { profile: { nodes: Node[] } };
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    let total = 0;
    let idle = 0;
    const paths = new Map<string, number>();
    for (const n of profile.nodes) {
      const hits = n.hitCount ?? 0;
      if (!hits) continue;
      total += hits;
      if (n.callFrame.functionName === "(idle)") {
        idle += hits;
        continue;
      }
      const p: string[] = [];
      for (let at: number | undefined = n.id; at !== undefined && p.length < depth; at = parent.get(at)) {
        const f = byId.get(at)!;
        if (f.callFrame.functionName !== "(root)") p.push(frame(f));
      }
      const key = p.join("\n");
      paths.set(key, (paths.get(key) ?? 0) + hits);
    }
    const share = (h: number) => (total ? Math.round((h / total) * 1000) / 10 : 0);
    const top = [...paths].sort((a, b) => b[1] - a[1]).slice(0, count).map(([k, h]) => ({ share: share(h), path: k.split("\n") }));
    return { ms, idle: share(idle), top };
  } finally {
    await s.post("Profiler.disable").catch(() => {});
    s.disconnect();
  }
}
