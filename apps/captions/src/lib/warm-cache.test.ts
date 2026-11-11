import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAuth } from "./auth";
import { clearLocalCache } from "./local-cache";
import { settingsLists, warmScreens } from "./warm-cache";

const admin = { username: "tinyadmin", role: "admin", cloud: false, off: [] };
const keys = (role: string, hosted: boolean) => settingsLists({ role } as never, hosted).map(([url]) => url);

afterEach(() => {
  clearLocalCache();
  vi.unstubAllGlobals();
});

it("warms a Settings list under the key its section reads (a renamed key would warm nothing)", () => {
  const src = path.join(import.meta.dirname, "..");
  const settings = path.join(src, "components", "settings");
  const files = [...readdirSync(settings).filter((f) => f.endsWith(".tsx") && !f.includes(".test.")).map((f) => path.join(settings, f)), path.join(src, "components", "AdminPanel.tsx"), path.join(src, "lib", "providers.ts")];
  const read = files.map((f) => readFileSync(f, "utf8")).filter((text) => text.includes("useCachedLoad")).join("\n");
  for (const url of keys("admin", true)) expect(read, url).toContain(`"${url}"`);
});

it("warms only what the account may read: the team on a hosted server, the admin pages for its admins", () => {
  expect(keys("user", false)).not.toContain("/api/workspace");
  expect(keys("admin", false)).not.toContain("/api/admin/users");
  expect(keys("user", true)).toContain("/api/workspace");
  expect(keys("user", true)).not.toContain("/api/admin/users");
  expect(keys("admin", true)).toEqual(expect.arrayContaining(["/api/workspace", "/api/service-keys", "/api/admin/users", "/api/admin/projects"]));
  // Social accounts too: its read asks no other server
  expect(keys("user", false)).toContain("/api/connectors");
});

it("saves \"no sign-in apps\" for a server that has none, so that read is not asked again on every start", async () => {
  vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404 }));
  const load = settingsLists({ role: "user" } as never, false).find(([url]) => url === "/api/account/providers")![1];
  expect(await load()).toEqual({ apple: false, google: false, github: false });
});

it("reads a Settings list once per device, while the app's own lists are read on every start", async () => {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => (asked.push(String(url).split("?")[0]), new Response("[]", { status: 200 })));
  useAuth.setState({ me: admin as never, hosted: true });
  await warmScreens();
  expect(asked).toEqual(expect.arrayContaining(["/api/my-keys", "/api/providers", "/api/admin/users", "/api/review"]));
  asked.length = 0;
  await warmScreens();
  expect(asked).toContain("/api/review");
  for (const url of keys("admin", true)) expect(asked, url).not.toContain(url);
});
