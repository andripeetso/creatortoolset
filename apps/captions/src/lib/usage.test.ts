import { describe, expect, it } from "vitest";
import type { ProviderInstance, ProvidersView } from "@contracts/providers";
import { SERVER_ENV, columnsOf, entriesOf, filterEntries, groupBy, servicesOf, totalsOf } from "./usage";

const inst = (id: string, device: string) => ({ id, driver: "claude", name: `Claude ${id}`, enabled: true, device }) as ProviderInstance;
const row = (over: Partial<ProvidersView["usage"][number]>): ProvidersView["usage"][number] => ({ hour: "2026-11-22T09", label: "Content Workshop", scope: "sam", calls: 1, tokens: 100, costUsd: 1, ...over });
const view = (usage: ProvidersView["usage"]) =>
  ({ usage, own: { instances: [inst("a", "dev_1"), inst("b", "dev_2")] }, workspace: null }) as unknown as Pick<ProvidersView, "usage" | "own" | "workspace">;

describe("usage entries", () => {
  const rows = [
    row({ instance: "a", model: "claude-opus-5-5", tokens: 100, input: 10, cacheRead: 60, cacheWrite: 10, output: 20, costUsd: 2, workspace: "brand-one" }),
    row({ instance: "b", model: "gpt-5.5", hour: "2026-11-23T10", tokens: 50, input: 30, output: 20, costUsd: 0.5 }),
    // recorded before models and token types were kept
    row({ instance: "a", tokens: 400, costUsd: 4, workspace: "brand-one" }),
    row({ label: "Content Workshop (API)", scope: "workspace", tokens: 10, costUsd: 0.1 }),
  ];
  const all = entriesOf(view(rows));

  it("names each line's provider, computer and model; the API key and no provider run on the server", () => {
    expect(all.map((e) => [e.providerName, e.env, e.model])).toEqual([
      ["Claude a", "dev_1", "claude-opus-5-5"],
      ["Claude b", "dev_2", "gpt-5.5"],
      ["Claude a", "dev_1", ""],
      ["Anthropic API key", SERVER_ENV, ""],
    ]);
  });

  it("totals the token types; tokens of old lines count as not split", () => {
    const t = totalsOf(all);
    expect(t).toMatchObject({ calls: 4, tokens: 560, input: 40, cacheRead: 60, cacheWrite: 10, output: 40, unsplit: 410 });
    expect(t.costUsd).toBeCloseTo(6.6);
    // 60 cache-read tokens of Opus 5.5 at $4 input instead of $0.20
    expect(t.savingsUsd).toBeCloseTo((60 * 3.8) / 1e6);
  });

  it("groups by model with an old line under no model, biggest first", () => {
    expect(groupBy(all, (e) => e.model).map((g) => [g.key, g.calls, g.tokens])).toEqual([
      ["", 2, 410],
      ["claude-opus-5-5", 1, 100],
      ["gpt-5.5", 1, 50],
    ]);
    expect(groupBy(all, (e) => e.model, "tokens")[0]?.key).toBe("");
  });

  it("filters by computer, provider, workspace and time", () => {
    const since = Date.parse("2026-11-22T00:00:00Z");
    expect(filterEntries(all, { since, env: "dev_1" })).toHaveLength(2);
    expect(filterEntries(all, { since, provider: "api" })).toHaveLength(1);
    expect(filterEntries(all, { since, workspace: "brand-one" })).toHaveLength(2);
    expect(filterEntries(all, { since: Date.parse("2026-11-23T00:00:00Z") })).toHaveLength(1);
  });

  it("makes one chart column per day, empty days included, split by provider", () => {
    const cols = columnsOf(all, Date.parse("2026-11-21T12:00:00Z"), Date.parse("2026-11-23T12:00:00Z"), "tokens");
    expect(cols.map((c) => c.at)).toEqual(["2026-11-21", "2026-11-22", "2026-11-23"]);
    expect(cols[1]?.by).toEqual({ "sam:a": 500, api: 10 });
    expect(cols[2]?.by).toEqual({ "sam:b": 50 });
    expect(cols[0]?.by).toEqual({});
  });

  it("makes one column per hour over one day", () => {
    const now = Date.parse("2026-11-23T10:30:00Z");
    expect(columnsOf(all, now - 864e5, now, "cost")).toHaveLength(25);
  });
});

describe("API keys", () => {
  const line = (service: string, label: string, calls: number, costUsd: number, workspace?: string) => ({ hour: "2026-11-23T09", service, label, whose: "own" as const, calls, units: calls * 2, unit: "minutes", costUsd, ...(workspace ? { workspace } : {}) });
  const lines = [line("DEEPGRAM_API_KEY", "Captions", 2, 0.5), line("DEEPGRAM_API_KEY", "Media Library", 1, 1, "brand-one"), line("APIFY_TOKEN", "Content Analyzer", 3, 0.2)];

  it("sums each key with its tools, costliest first", () => {
    const [deepgram, apify] = servicesOf(lines, 0);
    expect(deepgram).toMatchObject({ service: "DEEPGRAM_API_KEY", calls: 3, costUsd: 1.5, units: { minutes: 6 } });
    expect(deepgram?.tools.map((t) => t.label)).toEqual(["Media Library", "Captions"]);
    expect(apify?.service).toBe("APIFY_TOKEN");
  });

  it("keeps one workspace's lines when one is picked", () => {
    expect(servicesOf(lines, 0, "brand-one").map((g) => [g.service, g.calls])).toEqual([["DEEPGRAM_API_KEY", 1]]);
  });
});
