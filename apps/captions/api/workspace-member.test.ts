import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "workspace-member-"));
const { memberView } = await import("./workspace");

type Acct = Parameters<typeof memberView>[1];
const member = { username: "alex", role: "member" as const, ai: "budget" as const, budgetUsd: 25, joinedAt: 1 };
const acct = { displayName: "Alex Park", usage: { logins: 3, lastActiveAt: 500 }, off: ["notes"] } as unknown as Acct;

describe("a team member's view carries the account's name, read-only", () => {
  it("a manager sees the name next to the spend, activity and ticks", () => {
    expect(memberView(member, acct, true, 14.2)).toMatchObject({ username: "alex", name: "Alex Park", spentUsd: 14.2, lastActiveAt: 500, off: ["notes"] });
  });

  it("another member sees the name and the role, but no spend, activity or ticks", () => {
    expect(memberView(member, acct, false, 14.2)).toMatchObject({ username: "alex", name: "Alex Park", role: "member", spentUsd: 0, lastActiveAt: 0, off: [] });
  });

  it("falls back to the sign-in name alone when the account has no display name or is gone", () => {
    const unnamed = { usage: { logins: 1, lastActiveAt: 0 }, off: [] } as unknown as Acct;
    expect(memberView(member, unnamed, true, 0).name).toBeUndefined();
    expect(memberView(member, null, true, 0)).toMatchObject({ username: "alex", lastActiveAt: 0 });
    expect(memberView(member, null, true, 0).name).toBeUndefined();
  });
});
