import { describe, expect, it } from "vitest";
import { resolveSection, sectionsFor, type NavContext } from "@/components/settings/nav";

const local: NavContext = { hosted: false, admin: true, mac: false };
const localMember: NavContext = { hosted: false, admin: false, mac: false };
const hostedAdmin: NavContext = { hosted: true, admin: true, mac: false };
const hostedMember: NavContext = { hosted: true, admin: false, mac: false };
const ids = (ctx: NavContext) => sectionsFor(ctx, []).map((s) => s.id);

describe("Settings sections by server mode", () => {
  it("a local server has no team and no admin section, for anyone", () => {
    expect(ids(local)).not.toContain("team");
    expect(ids(local)).not.toContain("admin");
    expect(ids(localMember)).not.toContain("team");
  });

  it("a hosted server shows the team to everyone and the admin only to admins", () => {
    expect(ids(hostedMember)).toContain("team");
    expect(ids(hostedMember)).not.toContain("admin");
    expect(ids(hostedAdmin)).toEqual(expect.arrayContaining(["team", "admin"]));
  });

  it("keeps General first and the admin block last", () => {
    const all = ids(hostedAdmin).filter((id) => id !== "account"); // account is routable, not in the sidebar
    expect(all[0]).toBe("general");
    expect(all.at(-1)).toBe("admin");
  });

  it("shows one keys page to everyone, and no separate setup, this-mac or my-keys sections", () => {
    const all = ids(localMember);
    expect(all).toContain("keys");
    expect(all).not.toContain("setup");
    expect(all).not.toContain("this-mac");
    expect(all).not.toContain("my-keys");
  });
});

describe("Settings redirects", () => {
  it("sends retired ids where they went", () => {
    expect(resolveSection("setup", local)).toEqual({ kind: "redirect", to: "/settings/general" });
    expect(resolveSection("cache", local)).toEqual({ kind: "redirect", to: "/settings/general" });
    expect(resolveSection("this-mac", local)).toEqual({ kind: "redirect", to: "/settings/devices" });
    expect(resolveSection("my-keys", local)).toEqual({ kind: "redirect", to: "/settings/keys" });
    expect(resolveSection("packs", local)).toEqual({ kind: "redirect", to: "/community/installed" });
  });

  it("sends the editor id out of Settings to the AI Editor page, except in the Mac app on its own server (its steps page)", () => {
    expect(resolveSection("editor", local)).toEqual({ kind: "redirect", to: "/editor" });
    expect(resolveSection("editor", { ...local, mac: true })).toEqual({ kind: "page", id: "editor" });
  });

  it("sends a page this install does not show to General", () => {
    expect(resolveSection("team", local)).toEqual({ kind: "redirect", to: "/settings/general" });
    expect(resolveSection("admin", hostedMember)).toEqual({ kind: "redirect", to: "/settings/general" });
    expect(resolveSection("nope", local)).toEqual({ kind: "redirect", to: "/settings/general" });
  });

  it("opens the account page, which the sidebar does not list", () => {
    expect(resolveSection("account", localMember)).toEqual({ kind: "page", id: "account" });
  });
});
