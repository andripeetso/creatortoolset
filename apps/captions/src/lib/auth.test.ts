import { beforeEach, describe, expect, it } from "vitest";
import {
  VIEW_AS_OPTIONS,
  canUse,
  canUseCloud,
  returnTo,
  useAuth,
  viewedMe,
  type Me,
} from "./auth";

const admin: Me = {
  username: "owner",
  role: "admin",
  cloud: true,
  off: [],
  logins: 12,
};

describe("admin role preview", () => {
  beforeEach(() => {
    useAuth.setState({ required: true, me: admin, viewAs: null });
  });

  it.each(VIEW_AS_OPTIONS)(
    "maps the admin UI to $label capabilities",
    (option) => {
      expect(viewedMe(admin, option.id)).toEqual({ ...admin, role: option.role, off: option.off });
    },
  );

  it("never changes the real admin identity in the auth store", () => {
    useAuth.getState().setViewAs("guest");

    expect(useAuth.getState().me).toBe(admin);
    expect(useAuth.getState().viewAs).toBe("guest");
  });

  it("does not let non-admin accounts start or retain a preview", () => {
    const user: Me = {
      username: "member",
      role: "user",
      cloud: false,
      off: [],
    };
    useAuth.getState().setAuth(true, user);
    useAuth.getState().setViewAs("user");

    expect(useAuth.getState().viewAs).toBeNull();
    expect(viewedMe(user, "guest")).toBe(user);
  });

  it("opens an app unless it is switched off; admins get every one", () => {
    const member: Me = { username: "member", role: "user", cloud: true, off: ["guides"] };
    expect(canUse(member, "review")).toBe(true);
    expect(canUse(member, "instagram")).toBe(true);
    expect(canUse(member, "guides")).toBe(false);
    expect(canUse({ ...admin, off: ["guides"] }, "guides")).toBe(true);
    expect(canUse(null, "captions")).toBe(false);
  });

  it("previews a guest as guests are: Caption Studio, Story Splitter, Review and the Audio Enhancer", () => {
    const guest = viewedMe(admin, "guest");
    expect(canUseCloud(guest)).toBe(true);
    for (const tool of ["captions", "stories", "review", "enhance"] as const) expect(canUse(guest, tool)).toBe(true);
    expect(canUse(guest, "notes")).toBe(false);
    expect(canUse(guest, "clean")).toBe(false);
  });
});

describe("returnTo after signing in", () => {
  const prod = "https://creatortoolset.com";
  const next = (url: string) => `?next=${encodeURIComponent(url)}`;

  it("goes back to a page here", () => {
    expect(returnTo(next("/review"), prod)).toBe("https://creatortoolset.com/review");
    expect(returnTo("", prod)).toBeNull();
    expect(returnTo(next("https://media.creatortoolset.com/x"), prod)).toBe("https://media.creatortoolset.com/x");
    expect(returnTo(next("https://media.tools.example.com/"), "https://tools.example.com")).toBe("https://media.tools.example.com/");
  });

  it("never sends anyone anywhere else", () => {
    for (const bad of [
      "https://evil.example/", "https://creatortoolset.com.evil.example/", "https://xcreatortoolset.com/",
      "http://media.example.com/", "javascript:alert(1)", "//evil.example/x",
    ]) expect(returnTo(next(bad), prod)).toBeNull();
  });

  it("allows localhost ports only from localhost", () => {
    expect(returnTo(next("http://localhost:8080/"), "http://localhost:3000"))
      .toBe("http://localhost:8080/");
    expect(returnTo(next("http://localhost:8080/"), prod)).toBeNull();
  });
});
