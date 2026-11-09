import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The member API budget end to end on the real team store (no mocks): a member on a budget with no provider or key
// of their own runs on the workspace's API key, the call's cost is recorded on their month, and the next call is
// refused once the budget is spent. A member on their own AI, or with no budget, never reaches the server key.
const dir = mkdtempSync(path.join(tmpdir(), "ai-budget-spend-"));
process.env.DATA_DIR = dir;
process.env.CT_MODE = "hosted";
process.env.ANTHROPIC_API_KEY = "sk-test-spend";

// the seed is read on the first workspace call, so it is written before anything touches the store
const SEED = {
  workspaces: [
    {
      id: "ws-1",
      name: "Team",
      plan: "team",
      comped: false,
      createdAt: 0,
      members: [
        { username: "alex", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
        { username: "ana", role: "member", ai: "budget", budgetUsd: 0.01, joinedAt: 0 },
        { username: "cy", role: "member", ai: "budget", budgetUsd: 1, joinedAt: 0 },
        { username: "bo", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
      ],
    },
  ],
  invites: [],
  spend: {},
};
writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify(SEED));

const { aiFor, completeWithFallback, streamWithFallback } = await import("./ai-complete");
const { budgetLeft, spentThisMonth } = await import("./lib/workspaces");

// 1000 in and 500 out at the table's Opus price is $0.014: more than ana's $0.01, so one call spends her budget
const USAGE = { input_tokens: 1000, output_tokens: 500 };
const jsonResp = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const sse = (text: string) =>
  new Response(
    [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: USAGE.input_tokens } } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: USAGE.output_tokens } })}\n\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join(""),
    { status: 200 },
  );

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env.CT_MODE;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("member API budget on the real store", () => {
  it("a budget member with no key of their own gets the workspace API key, and no Mac provider", () => {
    const o = aiFor("ana", "notes", "Notes");
    expect(o.only).toEqual(["anthropic"]);
    expect(o.apiKey).toBe("sk-test-spend");
    expect(o.bill).toBe("ana");
    expect(budgetLeft("ana")).toBeCloseTo(0.01, 5);
  });

  it("a member without a budget never gets the server key, even with it set", () => {
    const o = aiFor("bo", "notes", "Notes");
    expect(o.only).toEqual([]);
    expect(o.apiKey).toBeUndefined();
    expect(o.off).toMatch(/No AI for your account/);
  });

  it("the answer's cost is recorded on the member's month, and the next call is refused without a request", async () => {
    const fetchMock = vi.fn(async () => jsonResp({ content: [{ type: "text", text: "ok" }], usage: USAGE }));
    vi.stubGlobal("fetch", fetchMock);

    const answer = await completeWithFallback("sys", "user", undefined, (t) => t, aiFor("ana", "notes", "Notes"));
    expect(answer).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spentThisMonth("ana")).toBeCloseTo(0.014, 5);
    expect(budgetLeft("ana")).toBeLessThanOrEqual(0);

    const refused = aiFor("ana", "notes", "Notes");
    expect(refused.off).toMatch(/used up/);
    expect(refused.only).toEqual([]);
    expect(refused.apiKey).toBeUndefined();
    await expect(completeWithFallback("sys", "user", undefined, (t) => t, refused)).rejects.toThrow(/used up/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a streamed answer's cost is recorded on the member's month too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse("streamed")));
    const { result } = await streamWithFallback("sys", "user", undefined, (t) => t, {}, aiFor("cy", "notes", "Notes"));
    expect(result).toBe("streamed");
    expect(spentThisMonth("cy")).toBeCloseTo(0.014, 5);
    expect(budgetLeft("cy")).toBeCloseTo(1 - 0.014, 5);
  });
});
