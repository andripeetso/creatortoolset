import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";

// The server's name (serverNameOf): "Creator Toolset Cloud" only where a plug-in names the server so (plugins/hosted on
// creatortoolset.com); every other server, a hosted own server like the studio too, is its first admin's.

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "server-name-"));
process.env.DATA_DIR = dir;
const { createUser } = await import("../users");
const { mountPlugins } = await import("../lib/plugin");
const { serverNameOf } = await import("./server-work-routes");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("serverNameOf", () => {
  it("is the first admin's on a server, hosted or not, none on This Mac, and the plug-in's where one names it", () => {
    createUser("tiny", "password1", { role: "admin" });
    mountPlugins(new Hono(), []);
    expect(serverNameOf("hosted")).toBe("tiny's server");
    expect(serverNameOf("server")).toBe("tiny's server");
    expect(serverNameOf("local")).toBeUndefined();
    mountPlugins(new Hono(), [{ id: "cloud", serverName: "Creator Toolset Cloud" }]);
    expect(serverNameOf("hosted")).toBe("Creator Toolset Cloud");
  });
});
