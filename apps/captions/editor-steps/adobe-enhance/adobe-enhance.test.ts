import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// The plug-in inside the whole app, Chrome never started: its Settings routes, the engine on the Audio Enhancer
// (offered, refused, preferred) and the Audio Enhancer's setup row. Needs the plug-in in the app's registries, which
// `pnpm check` (or `node scripts/plugins.mjs`) writes from the plugins/ folder.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "adobe-plugin-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "adobe-plugin-secret";
process.env.NVIDIA_API_KEY = "";
process.env.ELEVENLABS_API_KEY = "";
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const { createUser } = await import("../../api/users");
const { serverPlugins } = await import("../../api/plugins.gen");
const { needsLine, readiness } = await import("../../contracts/tools");
const app = (await import("../../api/boot")).default;
type Setup = import("../../contracts/tools").SetupView;

async function login(username: string, password: string) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}
const admin = await login("admin", "adobe-plugin-secret");
createUser("member", "password1", { role: "user" });
const member = await login("member", "password1");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = async (p: string, h = admin): Promise<any> => (await app.request(p, { headers: h })).json();
const post = (p: string, h: Record<string, string> = admin) => app.request(p, { method: "POST", headers: h });
const files = path.join(dataDir, "plugins", "adobe-enhance", "admin");
const setupLine = async (h = admin) => {
  const v = (await get("/api/setup", h)) as Setup;
  const r = readiness("enhance", v.have);
  return r.ready ? "ready" : needsLine(r.missing);
};

afterEach(() => {
  delete process.env.ADOBE_ENHANCE_CHROME;
  delete process.env.CT_MODE;
  rmSync(files, { recursive: true, force: true });
});
// a file that exists stands in for Chrome: nothing here starts it
const chrome = () => (process.env.ADOBE_ENHANCE_CHROME = process.execPath);
const signIn = () => {
  mkdirSync(files, { recursive: true });
  writeFileSync(path.join(files, "signed-in"), "now");
};

describe("Adobe Enhance Speech", () => {
  it("is in the app this test runs in, with its name and line", async () => {
    expect(serverPlugins.find((p) => p.id === "adobe-enhance"), "run `node scripts/plugins.mjs` with this folder in plugins/").toBeTruthy();
    const { plugins } = await get("/api/plugins");
    expect(plugins).toContainEqual(
      expect.objectContaining({
        id: "adobe-enhance",
        name: "Adobe Enhance Speech",
        about: "Adobe's Enhance Speech in the Audio Enhancer, with your own Adobe account.",
        adds: [{ text: "Audio Enhancer setup: an Adobe sign-in", to: "/settings/tools" }],
      }),
    );
  });

  it("without Google Chrome: says so, offers no sign-in, and the Audio Enhancer row names both ways", async () => {
    process.env.ADOBE_ENHANCE_CHROME = "";
    expect(await get("/api/x/adobe-enhance")).toEqual({ chrome: false, signedIn: false, signingIn: false, off: null, error: null });
    expect((await post("/api/x/adobe-enhance/signin")).status).toBe(409);
    const a = await get("/api/enhance/availability");
    expect(a).toMatchObject({ adobespeech: false, default: "nvidia" });
    expect(a.why.adobespeech).toBe("Needs Google Chrome");
    expect(await setupLine()).toBe("Needs an API key or an Adobe sign-in");
  });

  it("with Chrome and not signed in: the engine waits for the sign-in; a sign-in through the Mac's tunnel is refused", async () => {
    chrome();
    expect(await get("/api/x/adobe-enhance")).toMatchObject({ chrome: true, signedIn: false });
    expect((await get("/api/enhance/availability")).why.adobespeech).toBe("Needs an Adobe sign-in");
    expect((await post("/api/x/adobe-enhance/signin", { ...admin, "cf-ray": "x" })).status).toBe(403);
    expect(await setupLine()).toBe("Needs an API key or an Adobe sign-in");
  });

  it("signed in: the Audio Enhancer is set up and a new file starts on Adobe", async () => {
    chrome();
    signIn();
    expect(await get("/api/x/adobe-enhance")).toMatchObject({ chrome: true, signedIn: true, off: null });
    expect(await get("/api/enhance/availability")).toMatchObject({ adobespeech: true, default: "adobespeech" });
    expect((await get("/api/setup")).have).toContain("plugin:adobe-enhance/enhance");
    expect((await get("/api/setup")).ways).toEqual([{ tool: "enhance", what: "An Adobe sign-in", have: "plugin:adobe-enhance/enhance", settings: "adobe-enhance" }]);
    expect(await setupLine()).toBe("ready");
  });

  it("held off by Adobe until a time: the card says why until then, the setup stays done, the other engines stay", async () => {
    chrome();
    signIn();
    writeFileSync(path.join(files, "off.json"), JSON.stringify({ reason: "Today's Adobe time is used up, back at 14:30", until: Date.now() + 60_000 }));
    const a = await get("/api/enhance/availability");
    expect(a).toMatchObject({ adobespeech: false, default: "nvidia" });
    expect(a.why.adobespeech).toBe("Today's Adobe time is used up, back at 14:30");
    expect((await get("/api/x/adobe-enhance")).off).toBe("Today's Adobe time is used up, back at 14:30");
    expect(await setupLine()).toBe("ready");
    // the time passed: offered again
    writeFileSync(path.join(files, "off.json"), JSON.stringify({ reason: "x", until: Date.now() - 1 }));
    expect(await get("/api/enhance/availability")).toMatchObject({ adobespeech: true });
  });

  it("Sign out forgets the profile", async () => {
    chrome();
    signIn();
    mkdirSync(path.join(files, "chrome-profile", "Default"), { recursive: true });
    expect(await (await post("/api/x/adobe-enhance/signout")).json()).toMatchObject({ signedIn: false });
    expect(existsSync(path.join(files, "chrome-profile"))).toBe(false);
    expect(existsSync(path.join(files, "signed-in"))).toBe(false);
  });

  it("is the Mac owner's only: a member and a hosted server get neither the routes nor the engine", async () => {
    chrome();
    expect((await app.request("/api/x/adobe-enhance", { headers: member })).status).toBe(403);
    expect((await post("/api/x/adobe-enhance/signin", member)).status).toBe(403);
    expect((await get("/api/enhance/availability", member)).why.adobespeech).toBe("Only this Mac's owner can use it");
    signIn();
    process.env.CT_MODE = "hosted";
    expect((await app.request("/api/x/adobe-enhance", { headers: admin })).status).toBe(403);
    expect((await get("/api/enhance/availability")).adobespeech).toBe(false);
  });
});
