import { describe, expect, it } from "vitest";
import { adminTabList } from "./AdminSection";

const footage = { id: "footage-access", title: "Footage" };
const admin = { role: "admin" };

describe("adminTabList (Settings → Admin tabs per install and role)", () => {
  it("shows nothing to a person who is not an admin", () => {
    expect(adminTabList({ role: "user" }, true, [footage])).toEqual([]);
    expect(adminTabList(null, true, [footage])).toEqual([]);
  });

  it("hosted admin: Accounts, Access, Projects, Server keys, then the plug-in tabs", () => {
    expect(adminTabList(admin, true, [footage]).map((t) => t.id)).toEqual(["users", "access", "projects", "server-keys", "footage-access"]);
  });

  it("own-computer install: no Server keys tab, plug-in tabs still follow the built-in ones", () => {
    expect(adminTabList(admin, false, [footage]).map((t) => t.id)).toEqual(["users", "access", "projects", "footage-access"]);
  });

  it("uses the names people read", () => {
    expect(adminTabList(admin, true, []).map((t) => t.label)).toEqual(["Accounts", "Access", "Projects", "Server keys"]);
  });
});
