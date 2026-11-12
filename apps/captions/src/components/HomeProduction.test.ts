import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@/lib/workshop-summary";
import { inProduction } from "./HomeProduction";

const session = (id: string, status: SessionSummary["status"], kind: SessionSummary["kinds"][number]): SessionSummary => ({
  id,
  title: `Tiny Acrobatics ${id}`,
  status,
  updatedAt: 0,
  kinds: [kind],
  working: false,
  ready: false,
});

describe("Home's In production", () => {
  it("counts the sessions Ready or In Production by their first piece, and says how many of each status", () => {
    const p = inProduction([
      session("a", "ready", "reel"),
      session("b", "production", "reel"),
      session("c", "ready", "carousel"),
      session("d", "writing", "reel"),
      session("e", "editing", "carousel"),
    ]);
    expect(p.parts).toEqual(["2 reels", "1 carousel"]);
    expect(p.lines).toEqual(p.parts);
    expect(p.says).toBe("2 waiting for production · 1 in production");
    expect(p.started.map((r) => r.id)).toEqual(["b"]);
    expect(p.waiting.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("keeps the stop to two lines when three kinds wait", () => {
    const p = inProduction([session("a", "ready", "reel"), session("b", "ready", "carousel"), session("c", "production", "youtube"), session("d", "ready", "youtube")]);
    expect(p.parts).toEqual(["1 reel", "1 carousel", "2 other"]);
    expect(p.lines).toEqual(["1 reel", "3 more"]);
  });

  it("says nothing when nothing waits", () => {
    const p = inProduction([session("a", "writing", "reel"), session("b", "published", "reel")]);
    expect(p.parts).toEqual([]);
    expect(p.says).toBe("");
  });
});
