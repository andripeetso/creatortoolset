import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ServiceUsageView } from "../../contracts/service-usage";
import type { AuthVars } from "../auth";
import type { SessionUser } from "../users";

const dir = mkdtempSync(path.join(tmpdir(), "service-usage-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "test-secret-123"; // accounts on; boots the "admin" account
vi.stubEnv("DEEPGRAM_API_KEY", "server-dg");
// no service's limits are read in these tests: a failed read gives none, and the endpoint still answers
vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
const { createUser } = await import("../users");
const { saveMyKey } = await import("../my-keys");
const { budgetRows, costOf, recordService, serviceUsageApp, setBudget } = await import("./service-usage");
const { keyFor } = await import("../my-keys");
createUser("lee", "password1");
saveMyKey("lee", "DEEPGRAM_API_KEY", "lee-dg");
afterAll(() => vi.unstubAllGlobals());

const as = (user: SessionUser) => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => (c.set("user", user), next()));
  app.route("/", serviceUsageApp);
  return async () => (await (await app.request(`/services?since=${Date.now() - 864e5}`)).json()) as ServiceUsageView;
};
const lee = as({ username: "lee", role: "user", cloud: true, off: [] });
const admin = as({ username: "admin", role: "admin", cloud: true, off: [] });

describe("service usage", () => {
  it("costs: the service's own figure wins, else the price list, else 0", () => {
    expect(costOf("DEEPGRAM_API_KEY", 10, "audio minutes")).toBeCloseTo(0.043);
    expect(costOf("PERPLEXITY_API_KEY", 5000, "tokens", 0.012)).toBe(0.012);
    expect(costOf("YOUTUBE_API_KEY", 3, "quota units")).toBe(0);
  });

  it("tallies calls by hour, label and whose key; the owner of an own key is found by the key", async () => {
    await recordService({ service: "DEEPGRAM_API_KEY", key: "lee-dg", actor: "lee", label: "Caption Studio: captions", units: 2, unit: "audio minutes", workspace: null });
    await recordService({ service: "DEEPGRAM_API_KEY", key: "lee-dg", label: "Caption Studio: captions", units: 3, unit: "audio minutes", workspace: null });
    await recordService({ service: "DEEPGRAM_API_KEY", key: "server-dg", actor: "admin", label: "Media Library: transcripts", units: 1, unit: "audio minutes", workspace: null });
    const own = (await lee()).lines.filter((l) => l.service === "DEEPGRAM_API_KEY");
    expect(own).toEqual([expect.objectContaining({ label: "Caption Studio: captions", whose: "own", calls: 2, units: 5, unit: "audio minutes" })]);
    expect(own[0]!.costUsd).toBeCloseTo(5 * 0.0043);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(path.join(dir, "service-usage.json"), "utf-8"))).toBeTruthy());
  });

  it("a member sees only their own calls; an admin also every call on the server's keys, a member's under Team use too", async () => {
    await recordService({ service: "DEEPGRAM_API_KEY", key: "server-dg", actor: "lee", label: "Video Notes: transcripts", units: 1, unit: "audio minutes", workspace: null });
    const mine = await lee();
    expect(mine.lines.map((l) => l.label).sort()).toEqual(["Caption Studio: captions", "Video Notes: transcripts"]);
    expect(mine.lines.find((l) => l.label === "Media Library: transcripts")).toBeUndefined();
    const all = await admin();
    expect(all.lines.map((l) => `${l.label}:${l.whose}`).sort()).toEqual(["Media Library: transcripts:server", "Video Notes: transcripts:server"]);
    expect(all.limits).toEqual([]);
  });

  it("a key's monthly budget: near it Activity warns, at it keyFor refuses that key alone with the reason", async () => {
    const put = (user: SessionUser, body: unknown) => {
      const app = new Hono<{ Variables: AuthVars }>();
      app.use("*", async (c, next) => (c.set("user", user), next()));
      app.route("/", serviceUsageApp);
      return app.request("/budgets/DEEPGRAM_API_KEY", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    };
    const leeUser = { username: "lee", role: "user", cloud: true, off: [] } as SessionUser;
    expect((await put(leeUser, { whose: "server", budget: 1 })).status).toBe(403);
    expect((await put(leeUser, { whose: "own", budget: -1 })).status).toBe(400);
    const spent = (await lee()).budgets.find((b) => b.service === "DEEPGRAM_API_KEY" && b.whose === "own")!.spent;
    expect((await put(leeUser, { whose: "own", budget: spent + 1 })).status).toBe(200);
    expect(keyFor("lee", "DEEPGRAM_API_KEY")).toEqual({ key: "lee-dg" });
    // 200 minutes at $0.0043: about $0.86 more, past 80% of the budget, under it
    await recordService({ service: "DEEPGRAM_API_KEY", key: "lee-dg", actor: "lee", label: "Caption Studio: captions", units: 200, unit: "audio minutes", workspace: null });
    expect((await budgetRows("lee", false)).map((r) => r.title)).toEqual([expect.stringMatching(/^Deepgram: \d+% of monthly budget$/)]);
    await recordService({ service: "DEEPGRAM_API_KEY", key: "lee-dg", actor: "lee", label: "Caption Studio: captions", units: 100, unit: "audio minutes", workspace: null });
    expect(keyFor("lee", "DEEPGRAM_API_KEY")).toEqual({ key: "", missing: expect.stringContaining("Deepgram key reached its monthly budget") });
    expect((await budgetRows("lee", false))[0]).toMatchObject({ title: "Deepgram: monthly budget reached", href: "/settings/keys" });
    // the server's key has its own budget: none set, the admin's calls go on
    expect(keyFor("admin", "DEEPGRAM_API_KEY")).toEqual({ key: "server-dg" });
    setBudget("DEEPGRAM_API_KEY", "own:lee", null);
    expect(keyFor("lee", "DEEPGRAM_API_KEY")).toEqual({ key: "lee-dg" });
  });

  it("a workspace's budget on a key stops that key in that workspace alone, and is listed with its spend", async () => {
    const { usageIn } = await import("./mac-claude");
    await recordService({ service: "DEEPGRAM_API_KEY", key: "lee-dg", actor: "lee", label: "Caption Studio: captions", units: 100, unit: "audio minutes", workspace: "ws-aaaa01" });
    setBudget("DEEPGRAM_API_KEY", "own:lee", 0.4, "ws-aaaa01");
    setBudget("DEEPGRAM_API_KEY", "own:lee", 5, "ws-bbbb02");
    expect(usageIn("ws-aaaa01", () => keyFor("lee", "DEEPGRAM_API_KEY"))).toEqual({ key: "", missing: expect.stringContaining("this workspace's monthly budget of $0.4") });
    expect(usageIn("ws-bbbb02", () => keyFor("lee", "DEEPGRAM_API_KEY"))).toEqual({ key: "lee-dg" });
    expect(keyFor("lee", "DEEPGRAM_API_KEY")).toEqual({ key: "lee-dg" });
    const b = (await lee()).budgets.find((x) => x.service === "DEEPGRAM_API_KEY" && x.whose === "own")!;
    expect(b.budget).toBeNull();
    expect(b.workspaces).toEqual(expect.arrayContaining([{ id: "ws-aaaa01", budget: 0.4, spent: expect.closeTo(0.43, 2) }, { id: "ws-bbbb02", budget: 5, spent: 0 }]));
    expect((await budgetRows("lee", false)).map((r) => r.id)).toEqual(["budget:own:DEEPGRAM_API_KEY:ws-aaaa01"]);
    setBudget("DEEPGRAM_API_KEY", "own:lee", null, "ws-aaaa01");
    expect(usageIn("ws-aaaa01", () => keyFor("lee", "DEEPGRAM_API_KEY"))).toEqual({ key: "lee-dg" });
  });
});
