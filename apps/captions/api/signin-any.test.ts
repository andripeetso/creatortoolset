import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Settings → Team's sign-in can be any of Google, Apple and GitHub: saving needs the owner to have one of them linked,
// and a member passes the gate with any allowed one linked (auth.ts ruleFor).
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "signin-any-"));
process.env.APP_SECRET = "signin-any-test-secret";

const { createUser, findUser } = await import("./users");
createUser("boss", "bosspass1", { role: "admin" });
createUser("sam", "otherpass1", { role: "user" });
const { workspaceOf, setSignInWith } = await import("./lib/workspaces");
const { ruleFor } = await import("./auth");

describe("the team's sign-in can be any of Google, Apple and GitHub", () => {
  it("GitHub is accepted once the owner has it linked, and all three save together", () => {
    const w = workspaceOf("boss")!;
    expect(() => setSignInWith(w, "boss", ["github"])).toThrow(/Link your own GitHub account first/);
    expect(() => setSignInWith(w, "boss", ["google", "apple", "github"])).toThrow(/Link your own Google, Apple or GitHub account first/);

    findUser("boss")!.identities = [{ provider: "github", sub: "gh-boss", email: "boss@tinyacrobatics.com", linkedAt: 1 }];
    setSignInWith(w, "boss", ["google", "apple", "github", "nope"]);
    expect(w.signInWith).toEqual(["google", "apple", "github"]);
  });

  it("a member passes the gate with any one allowed provider linked, and is held with none", () => {
    expect(ruleFor("boss")?.missing).toBeNull();
    expect(ruleFor("sam")).toEqual({ allowed: ["google", "apple", "github"], missing: ["google", "apple", "github"] });
    findUser("sam")!.identities = [{ provider: "apple", sub: "a-sam", email: "sam@tinyacrobatics.com", linkedAt: 2 }];
    expect(ruleFor("sam")?.missing).toBeNull();
  });
});
