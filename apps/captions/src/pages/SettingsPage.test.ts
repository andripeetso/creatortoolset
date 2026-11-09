import { describe, expect, it } from "vitest";
import { visibleSettings } from "@/lib/plugin";
import { settingsSectionsFor } from "./SettingsPage";
import type { Me } from "@/lib/auth";

const admin: Me = { username: "owner", role: "admin", cloud: true, off: [] };
const member: Me = { username: "member", role: "user", cloud: true, off: [] };
const ids = (hosted: boolean, me: Me) => visibleSettings(settingsSectionsFor(hosted), me).map((s) => s.id);

describe("Settings sections by server mode", () => {
  it("a local server has no team and no admin section, for anyone", () => {
    expect(ids(false, admin)).not.toContain("team");
    expect(ids(false, admin)).not.toContain("admin");
    expect(ids(false, member)).not.toContain("team");
  });

  it("a hosted server shows the team to everyone and the admin only to admins", () => {
    expect(ids(true, member)).toContain("team");
    expect(ids(true, member)).not.toContain("admin");
    expect(ids(true, admin)).toEqual(expect.arrayContaining(["team", "admin"]));
  });

  it("keeps the built-in sections in place, with the admin block pinned last", () => {
    const all = ids(true, admin);
    expect(all.indexOf("general")).toBe(0);
    expect(all.at(-1)).toBe("admin");
    expect(all.indexOf("keys")).toBeLessThan(all.indexOf("cache"));
  });

  it("shows one keys page, to everyone, and no separate setup, this-mac or my-keys sections", () => {
    const all = ids(false, member);
    expect(all).toContain("keys");
    expect(all).not.toContain("setup");
    expect(all).not.toContain("this-mac");
    expect(all).not.toContain("my-keys");
  });
});
