import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../jev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev")>()),
  ask: vi.fn(),
}));

import { ask } from "../jev";
import { checkDraft, FLAG_MIN } from "./rule-check";
import type { Document, Rule } from "./types";

beforeEach(() => vi.clearAllMocks());

const rule = (id: string, name: string, text: string): Rule =>
  ({ id, owner: "a", name, text, on: true, createdAt: 0, updatedAt: 0 }) as Rule;
const doc = (extra: Partial<Document> = {}): Document =>
  ({ blocks: [{ id: "b1", text: "Research shows floor time helps.", author: "ai" }], ...extra }) as Document;

describe("checking a draft against its rules", () => {
  it("flags only clear breaks, strongest first", async () => {
    vi.mocked(ask).mockResolvedValueOnce({
      rule0: { noul: 0.93 },
      rule1: { noul: FLAG_MIN - 0.05 },
      captionQuestion: { noul: 0.9 },
    });
    const flags = await checkDraft(
      doc({ caption: { text: "how old was yours when they crawled", author: "ai", at: 0 } } as Partial<Document>),
      [rule("r1", "Show, don't claim", "Never say research shows without the finding."), rule("r2", "Write like you talk", "…")],
    );
    expect(flags.map((f) => f.name)).toEqual(["Show, don't claim", "The description asks a question"]);
  });

  it("asks one question per rule, plus the description and pinned comment when there are any", async () => {
    vi.mocked(ask).mockResolvedValueOnce({});
    await checkDraft(
      doc({ pinned: { text: "Save this", author: "ai", at: 0 } } as Partial<Document>),
      [rule("r1", "A", "a"), rule("r2", "B", "b")],
    );
    expect(Object.keys(vi.mocked(ask).mock.calls[0][1])).toEqual(["rule0", "rule1", "pinnedQuestion"]);
  });

  it("asks nothing with no rules and no description or pin", async () => {
    expect(await checkDraft(doc(), [])).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });
});
