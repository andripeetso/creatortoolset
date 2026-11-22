import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";

// The server's name (serverNameOf): "Creator Toolset Cloud" only where a plug-in names the server so (plugins/hosted on
// creatortoolset.com); every other server, a hosted own server like the studio too, is its first admin's.

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "server-name-"));
process.env.DATA_DIR = dir;
const users = await import("../users");
const { createUser, setDisplayName } = users;
const { mountPlugins } = await import("../lib/plugin");
const { serverNameOf } = await import("./server-work-routes");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("serverNameOf", () => {
  it("is the first admin's on a Server or Cloud, none on This Mac, and the plug-in's where one names it", () => {
    createUser("tiny", "password1", { role: "admin" });
    mountPlugins(new Hono(), []);
    expect(serverNameOf("cloud")).toBe("tiny's server");
    expect(serverNameOf("server")).toBe("tiny's server");
    expect(serverNameOf("mac")).toBeUndefined();
    mountPlugins(new Hono(), [{ id: "cloud", serverName: "Creator Toolset Cloud" }]);
    expect(serverNameOf("cloud")).toBe("Creator Toolset Cloud");
    expect(serverNameOf("server")).toBe("Creator Toolset Cloud");
    expect(serverNameOf("mac")).toBeUndefined(); // This Mac: unchanged, whatever a plug-in says
  });

  it("is the owner's display name before the username", () => {
    mountPlugins(new Hono(), []);
    setDisplayName(createUser("later", "password1", { role: "admin" }), "Later Admin"); // not the first admin
    expect(serverNameOf("cloud")).toBe("tiny's server");
    setDisplayName(users.findUser("tiny")!, "Tiny Acrobatics");
    expect(serverNameOf("cloud")).toBe("Tiny Acrobatics's server");
  });
});
