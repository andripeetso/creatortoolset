import { describe, expect, it } from "vitest";
import { adminTabList, retiredTabTarget } from "./AdminSection";

const footage = { id: "footage-access", title: "Footage" };
const admin = { role: "admin" };

describe("adminTabList (Settings → Admin tabs per install and role)", () => {
  it("shows nothing to a person who is not an admin", () => {
    expect(adminTabList({ role: "user" }, true, [footage])).toEqual([]);
    expect(adminTabList(null, true, [footage])).toEqual([]);
  });

  it("hosted admin: Accounts, Projects, Server keys, then the plug-in tabs (Access is in Team)", () => {
    expect(adminTabList(admin, true, [footage]).map((t) => t.id)).toEqual(["users", "projects", "server-keys", "footage-access"]);
  });

  it("own-computer install: no Server keys tab, plug-in tabs still follow the built-in ones", () => {
    expect(adminTabList(admin, false, [footage]).map((t) => t.id)).toEqual(["users", "access", "projects", "footage-access"]);
  });

  it("moves a retired tab id to its tab, and only when that tab is on this server", () => {
    const hosted = ["users", "access", "projects", "server-keys"];
    expect(retiredTabTarget("ai", hosted)).toBe("server-keys");
    expect(retiredTabTarget("apps", hosted)).toBe("access");
    expect(retiredTabTarget("ai", ["users", "access", "projects"])).toBeNull();
    expect(retiredTabTarget("access", hosted)).toBeNull();
    expect(retiredTabTarget(undefined, hosted)).toBeNull();
  });

  it("uses the names people read", () => {
    expect(adminTabList(admin, true, []).map((t) => t.label)).toEqual(["Accounts", "Projects", "Server keys"]);
  });
});
