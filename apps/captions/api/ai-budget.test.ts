import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A member on a monthly API budget (a Server or Cloud): the server's key, billed to them. The budget itself is a stub here.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ai-budget-"));
vi.mock("./lib/workspaces", async (orig) => ({
  ...(await orig<typeof import("./lib/workspaces")>()),
  budgetLeft: vi.fn((): number | null => null),
  addSpend: vi.fn(),
}));

// the admin's Team use switch (Settings → API keys → Server keys): off unless a test turns it on
vi.mock("./service-keys", async (orig) => ({
  ...(await orig<typeof import("./service-keys")>()),
  teamUseOn: vi.fn((): boolean => false),
}));

const { aiFor, completeWithFallback } = await import("./ai-complete");
const { teamAiKey } = await import("./my-keys");
const { budgetLeft, addSpend } = await import("./lib/workspaces");
const { teamUseOn } = await import("./service-keys");

const budgetLeftMock = vi.mocked(budgetLeft);
const addSpendMock = vi.mocked(addSpend);
const teamUseMock = vi.mocked(teamUseOn);

const jsonResp = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });

beforeEach(() => {
  process.env.CT_MODE = "hosted";
  process.env.ANTHROPIC_API_KEY = "sk-test-budget";
  budgetLeftMock.mockReturnValue(5);
  teamUseMock.mockReturnValue(true);
  addSpendMock.mockClear();
});

afterEach(() => {
  delete process.env.CT_MODE;
  delete process.env.ANTHROPIC_API_KEY;
  vi.unstubAllGlobals();
});

describe("member API budget", () => {
  it("runs on the server key, billed to the member, while the budget lasts", () => {
    const o = aiFor("ana", "notes", "Notes");
    expect(o.only).toEqual(["anthropic"]);
    expect(o.apiKey).toBe("sk-test-budget");
    expect(o.bill).toBe("ana");
    expect(o.off).toBeUndefined();
  });

  it("is refused, saying what is missing, while Team use is off", () => {
    teamUseMock.mockReturnValue(false);
    expect(aiFor("ana", "notes", "Notes").off).toMatch(/^Needs Team use/);
  });

  it("hands the server key out only with Team use on and a member on a budget", () => {
    expect(teamAiKey("ana", "notes").key).toBe("sk-test-budget");
    teamUseMock.mockReturnValue(false);
    expect(teamAiKey("ana", "notes").key).toBe("");
    teamUseMock.mockReturnValue(true);
    budgetLeftMock.mockReturnValue(null);
    expect(teamAiKey("ana", "notes").key).toBe("");
  });

  it("is refused once the month's budget is used up", () => {
    budgetLeftMock.mockReturnValue(0);
    expect(aiFor("ana", "notes", "Notes").off).toBe("Budget used up this month: ask the admin");
  });

  it("never runs the Workshop, which reads the session's folder", () => {
    expect(aiFor("ana", "workshop", "Workshop").off).toMatch(/Content Workshop/);
  });

  it("is off on This Mac, even for a member with a budget", () => {
    process.env.CT_SERVER = "mac";
    expect(aiFor("ana", "notes", "Notes").off).toMatch(/No AI for your account/);
    delete process.env.CT_SERVER;
  });

  it("is not a route for someone not on a budget", () => {
    budgetLeftMock.mockReturnValue(null);
    expect(aiFor("ana", "notes", "Notes").off).toMatch(/No AI for your account/);
  });

  it("bills the API answer's cost to the member", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResp({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 500 } })),
    );
    const answer = await completeWithFallback("sys", "user", undefined, (t) => t, aiFor("ana", "notes", "Notes"));
    expect(answer).toBe("ok");
    expect(addSpendMock).toHaveBeenCalledWith("ana", expect.any(Number));
  });
});
