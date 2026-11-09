import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A member on a monthly API budget (hosted only): the server's key, billed to them. The budget itself is a stub here.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ai-budget-"));
vi.mock("./lib/workspaces", async (orig) => ({
  ...(await orig<typeof import("./lib/workspaces")>()),
  budgetLeft: vi.fn((): number | null => null),
  addSpend: vi.fn(),
}));

const { aiFor, completeWithFallback } = await import("./ai-complete");
const { budgetLeft, addSpend } = await import("./lib/workspaces");

const budgetLeftMock = vi.mocked(budgetLeft);
const addSpendMock = vi.mocked(addSpend);

const jsonResp = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });

beforeEach(() => {
  process.env.CT_MODE = "hosted";
  process.env.ANTHROPIC_API_KEY = "sk-test-budget";
  budgetLeftMock.mockReturnValue(5);
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

  it("is refused once the month's budget is used up", () => {
    budgetLeftMock.mockReturnValue(0);
    expect(aiFor("ana", "notes", "Notes").off).toMatch(/used up/);
  });

  it("never runs the Workshop, which reads the session's folder", () => {
    expect(aiFor("ana", "workshop", "Workshop").off).toMatch(/Content Workshop/);
  });

  it("is off outside hosted mode, even for a member with a budget", () => {
    delete process.env.CT_MODE;
    expect(aiFor("ana", "notes", "Notes").off).toMatch(/No AI for your account/);
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
