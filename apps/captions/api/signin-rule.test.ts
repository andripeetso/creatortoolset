import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Settings → Team's sign-in rule (Workspace.signInWith, auth.ts ruleFor, boot.ts LINK_SIGNIN) through the real app.
// Linking Google or Apple is the hosted-mode route (sign-in.ts); here an identity is set on the account directly.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "signin-rule-"));
process.env.APP_SECRET = "signin-rule-test-secret";

const { createUser, findUser, newApiKey } = await import("./users");
createUser("boss", "bosspass1", { role: "admin" });
createUser("sam", "otherpass1", { role: "user" });
const { workspaceOf, setSignInWith } = await import("./lib/workspaces");
const { ruleFor } = await import("./auth");
const app = (await import("./boot")).default;

const send = (url: string, method: string, body?: unknown, cookie = ""): Promise<Response> | Response =>
  app.request(url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

describe("the team's sign-in rule", () => {
  it("can't be set until the owner has the provider linked, then members link before anything else", async () => {
    const w = workspaceOf("boss")!;
    expect(() => setSignInWith(w, "boss", ["google"])).toThrow(/Link your own Google/);

    findUser("boss")!.identities = [{ provider: "google", sub: "g-boss", email: "boss@tinyacrobatics.com", linkedAt: 1 }];
    setSignInWith(w, "boss", ["google"]);
    expect(w.signInWith).toEqual(["google"]);
    expect(ruleFor("boss")?.missing).toBeNull();
    expect(ruleFor("sam")).toEqual({ allowed: ["google"], missing: ["google"] });

    // sam has the password but no Google linked: signed in, and only the auth routes answer until it links one
    const samCookie = cookieOf(await send("/api/auth/login", "POST", { username: "sam", password: "otherpass1" }));
    expect(samCookie).not.toBe("");
    const blocked = await send("/api/projects", "GET", undefined, samCookie);
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { code?: string }).code).toBe("LINK_SIGNIN");
    const check = (await (await send("/api/auth/check", "GET", undefined, samCookie)).json()) as { mustLink: string[] | null };
    expect(check.mustLink).toEqual(["google"]);

    // linked: the password is refused, and the reach is back
    findUser("sam")!.identities = [{ provider: "google", sub: "g-sam", email: "sam@tinyacrobatics.com", linkedAt: 2 }];
    const linked = await send("/api/projects", "GET", undefined, samCookie);
    expect(((await linked.json().catch(() => ({}))) as { code?: string }).code).not.toBe("LINK_SIGNIN");
    const refused = await send("/api/auth/login", "POST", { username: "sam", password: "otherpass1" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe("SIGNIN_RULE");

    // an unlinked member's AI review key is no way round the rule either
    findUser("sam")!.identities = [];
    const key = newApiKey(findUser("sam")!, "review");
    expect(key.startsWith("ctk_")).toBe(true);
    const viaKey = await send("/api/review/assets", "GET", undefined, "");
    expect(viaKey.status).toBe(401);
    const keyed = await app.request("/api/review/assets", { headers: { authorization: `Bearer ${key}` } });
    expect(((await keyed.json()) as { code?: string }).code).toBe("LINK_SIGNIN");

    // the owner clears the rule: the password works again
    setSignInWith(w, "boss", []);
    expect(w.signInWith).toBeUndefined();
    expect(ruleFor("sam")).toBeNull();
    expect((await send("/api/auth/login", "POST", { username: "sam", password: "otherpass1" })).status).toBe(200);
  });
});
