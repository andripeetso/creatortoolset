import { describe, expect, it } from "vitest";
import { canUse, returnTo, type Me } from "./auth";

const admin: Me = {
  username: "owner",
  role: "admin",
  cloud: true,
  off: [],
  logins: 12,
};

describe("canUse", () => {
  it("opens an app unless it is switched off; admins get every one", () => {
    const member: Me = { username: "member", role: "user", cloud: true, off: ["guides"] };
    expect(canUse(member, "review")).toBe(true);
    expect(canUse(member, "instagram")).toBe(true);
    expect(canUse(member, "guides")).toBe(false);
    expect(canUse({ ...admin, off: ["guides"] }, "guides")).toBe(true);
    expect(canUse(null, "captions")).toBe(false);
  });
});

describe("returnTo after signing in", () => {
  const prod = "https://tools.example.com";
  const next = (url: string) => `?next=${encodeURIComponent(url)}`;

  it("goes back to a page here", () => {
    expect(returnTo(next("/review"), prod)).toBe("https://tools.example.com/review");
    expect(returnTo("", prod)).toBeNull();
    expect(returnTo(next("https://media.tools.example.com/x"), prod)).toBe("https://media.tools.example.com/x");
    expect(returnTo(next("https://media.tools.example.com/"), "https://tools.example.com")).toBe("https://media.tools.example.com/");
  });

  it("never sends anyone anywhere else", () => {
    for (const bad of [
      "https://evil.example/", "https://tools.example.com.evil.example/", "https://xtools.example.com/",
      "http://media.example.com/", "javascript:alert(1)", "//evil.example/x",
    ]) expect(returnTo(next(bad), prod)).toBeNull();
  });

  it("allows localhost ports only from localhost", () => {
    expect(returnTo(next("http://localhost:8080/"), "http://localhost:3000"))
      .toBe("http://localhost:8080/");
    expect(returnTo(next("http://localhost:8080/"), prod)).toBeNull();
  });
});
