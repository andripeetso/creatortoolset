import { describe, expect, it } from "vitest";
import type { SocialPlatform } from "../../../contracts/connectors";
import { pullAccount } from "./platforms";
import { readers, readerFor, registerReader, sessionSources, type SocialReader } from "./provider";
import type { StoredAccount } from "./store";

const account = (platform: SocialPlatform, via: "login" | "apify") => ({ key: `${platform}:tinyacrobatics`, platform, platformId: "1", handle: "tinyacrobatics", via, token: "tok" }) as StoredAccount;

describe("reader registry", () => {
  it("the built-in readers cover every login platform and every Apify platform", () => {
    for (const p of ["facebook", "youtube", "tiktok"] as const) expect(readerFor(account(p, "login")), p).toBeDefined();
    for (const p of ["tiktok", "x", "youtube", "facebook"] as const) expect(readerFor(account(p, "apify")), p).toBeDefined();
  });

  it("the Instagram login reader takes an Instagram login, and no reader takes an Instagram handle", () => {
    expect(readerFor(account("instagram", "login"))).toBeDefined();
    expect(readerFor(account("instagram", "apify"))).toBeUndefined();
  });

  it("pullAccount hands the account to a registered reader that no built-in matches", async () => {
    const seen: string[] = [];
    const fake: SocialReader = {
      canRead: (a) => a.platform === "x" && a.via === "login",
      pull: async (_a, username) => {
        seen.push(username);
        return { stats: { followers: 5 }, posts: [] };
      },
    };
    registerReader(fake);
    try {
      const got = await pullAccount(account("x", "login"), "tinyacrobatics");
      expect(got.stats.followers).toBe(5);
      expect(seen).toEqual(["tinyacrobatics"]);
    } finally {
      readers.splice(readers.indexOf(fake), 1);
    }
  });

  it("lists only the session readers' sources; none in the public build", () => {
    expect(sessionSources()).toEqual([]);
    const session: SocialReader = { canRead: () => false, pull: async () => ({ stats: {}, posts: [] }), session: { id: "tinyacrobatics-session", label: "Tiny session", hint: "Set up on this server" } };
    registerReader(session);
    try {
      expect(sessionSources()).toEqual([session.session]);
    } finally {
      readers.splice(readers.indexOf(session), 1);
    }
  });

  it("an account no reader can read is refused, not read", async () => {
    await expect(pullAccount(account("x", "login"), "tinyacrobatics")).rejects.toThrow("Nothing can read x for this account");
  });
});
