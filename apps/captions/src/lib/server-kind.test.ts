import { beforeEach, describe, expect, it } from "vitest";
import { useAuth, type Me } from "./auth";
import { joinToken } from "./workspaces";

const admin: Me = { username: "owner", role: "admin", cloud: true, off: [] };
const member: Me = { username: "member", role: "user", cloud: true, off: [] };

beforeEach(() => {
  useAuth.setState({ required: false, me: null, kind: "mac", viewedBy: null });
});

describe("server kind and view-as state", () => {
  it("takes the kind and view-as from the server's check", () => {
    useAuth.getState().setAuth(true, member, { kind: "server", viewedBy: "owner" });
    expect(useAuth.getState().kind).toBe("server");
    expect(useAuth.getState().viewedBy).toBe("owner");
  });

  it("keeps the kind across a sign-in, and a sign-in ends a view", () => {
    useAuth.getState().setAuth(true, admin, { kind: "server", viewedBy: "owner" });
    useAuth.getState().setAuth(true, admin);
    expect(useAuth.getState().kind).toBe("server");
    expect(useAuth.getState().viewedBy).toBeNull();
  });

  it("is This Mac by default, so no team screens show", () => {
    expect(useAuth.getState().kind).toBe("mac");
    expect(useAuth.getState().viewedBy).toBeNull();
  });
});

describe("join links", () => {
  const token = "a".repeat(40);

  it("reads the token from /join/<token>", () => {
    expect(joinToken(`/join/${token}`)).toBe(token);
    expect(joinToken(`/join/${token}/`)).toBe(token);
  });

  it("ignores other paths and malformed tokens", () => {
    expect(joinToken("/join/short")).toBeNull();
    expect(joinToken(`/join/${"A".repeat(40)}`)).toBeNull();
    expect(joinToken(`/settings/team/${token}`)).toBeNull();
  });
});
