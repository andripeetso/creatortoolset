import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "ig-session-"));
process.env.DATA_DIR = dataDir;
delete process.env.INSTAGRAM_COOKIE;
const {
  checkSession,
  clearSession,
  igHeaders,
  markInvalid,
  missingCookies,
  parseCookieInput,
  publicSessionStatus,
  readSession,
  writeSession,
} = await import("./session");
type StoredSession = import("./session").StoredSession;

const full = "sessionid=abc; csrftoken=tok; ds_user_id=42; mid=m; ig_did=d";
const OWNER = "alex";

describe("parseCookieInput", () => {
  it("parses a Cookie request header, with or without the prefix", () => {
    expect(parseCookieInput(full)).toEqual([
      { name: "sessionid", value: "abc" },
      { name: "csrftoken", value: "tok" },
      { name: "ds_user_id", value: "42" },
      { name: "mid", value: "m" },
      { name: "ig_did", value: "d" },
    ]);
    expect(parseCookieInput(`Cookie: ${full}`)).toHaveLength(5);
  });

  it("parses a Netscape cookies.txt export and ignores other domains", () => {
    const txt = [
      "# Netscape HTTP Cookie File",
      ".instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc",
      ".instagram.com\tTRUE\t/\tTRUE\t0\tcsrftoken\ttok",
      ".instagram.com\tTRUE\t/\tFALSE\t0\tds_user_id\t42",
      ".facebook.com\tTRUE\t/\tTRUE\t0\tc_user\tnope",
    ].join("\n");
    expect(parseCookieInput(txt).map((c) => c.name)).toEqual([
      "sessionid",
      "csrftoken",
      "ds_user_id",
    ]);
  });

  it("parses JSON arrays and objects", () => {
    expect(parseCookieInput('[{"name":"sessionid","value":"abc"}]')).toEqual([
      { name: "sessionid", value: "abc" },
    ]);
    expect(parseCookieInput('{"csrftoken":"tok"}')).toEqual([{ name: "csrftoken", value: "tok" }]);
  });

  it("dedupes with the last value winning and drops empties", () => {
    expect(parseCookieInput("a=1; a=2; b=; =c")).toEqual([{ name: "a", value: "2" }]);
  });
});

describe("missingCookies", () => {
  it("names what is required", () => {
    expect(missingCookies(parseCookieInput("sessionid=abc"))).toEqual(["csrftoken", "ds_user_id"]);
    expect(missingCookies(parseCookieInput(full))).toEqual([]);
  });
});

describe("igHeaders", () => {
  it("sends the cookies, app id, and csrf token", () => {
    const s: StoredSession = {
      cookies: parseCookieInput(full),
      savedAt: 1,
      savedBy: "t",
      valid: null,
      source: "file",
    };
    const h = igHeaders(s, { Referer: "https://www.instagram.com/p/x/" });
    expect(h.Cookie).toBe(full);
    expect(h["X-CSRFToken"]).toBe("tok");
    expect(h["X-IG-App-ID"]).toBe("936619743392459");
    expect(h.Referer).toBe("https://www.instagram.com/p/x/");
  });
});

describe("session store", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearSession(OWNER);
  });

  it("writes an owner-only file, reads it back, and never exposes values", async () => {
    await writeSession(OWNER, {
      cookies: parseCookieInput(full),
      savedAt: 123,
      savedBy: OWNER,
      valid: null,
      source: "file",
    });
    const file = path.join(dataDir, "instagram", "users", OWNER, "session.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const s = await readSession(OWNER);
    expect(s?.cookies).toHaveLength(5);
    const status = publicSessionStatus(s);
    expect(status).toEqual({
      configured: true,
      valid: null,
      checkedAt: undefined,
      savedAt: 123,
      savedBy: OWNER,
      account: undefined,
      invalidReason: undefined,
      source: "file",
    });
    expect(JSON.stringify(status)).not.toContain("abc");
  });

  it("marks the session invalid with a reason", async () => {
    await writeSession(OWNER, {
      cookies: parseCookieInput(full),
      savedAt: 1,
      savedBy: OWNER,
      valid: true,
      source: "file",
    });
    await markInvalid(OWNER, "login wall");
    const s = await readSession(OWNER);
    expect(s?.valid).toBe(false);
    expect(s?.invalidReason).toBe("login wall");
  });

  it("returns null when nothing is stored", async () => {
    expect(await readSession(OWNER)).toBeNull();
    expect(publicSessionStatus(null)).toEqual({ configured: false, valid: null, source: "none" });
  });

  it("checkSession accepts a JSON profile answer and reads the account name", async () => {
    await writeSession(OWNER, {
      cookies: parseCookieInput(full),
      savedAt: 1,
      savedBy: OWNER,
      valid: null,
      source: "file",
    });
    const fetchImpl = vi.fn(async (url: string) => {
      const body = url.includes("web_profile_info")
        ? { data: { user: { username: "instagram" } } }
        : { user: { username: "burner_acct" } };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: null,
        json: async () => body,
      } as unknown as Response;
    });
    const s = await checkSession(OWNER, fetchImpl as unknown as typeof fetch);
    expect(s?.valid).toBe(true);
    expect(s?.account).toEqual({ id: "42", username: "burner_acct" });
  });

  it("checkSession treats HTML as the login wall", async () => {
    await writeSession(OWNER, {
      cookies: parseCookieInput(full),
      savedAt: 1,
      savedBy: OWNER,
      valid: true,
      source: "file",
    });
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          body: null,
        }) as unknown as Response,
    );
    const s = await checkSession(OWNER, fetchImpl as unknown as typeof fetch);
    expect(s?.valid).toBe(false);
    expect(s?.invalidReason).toMatch(/login wall/i);
  });
});
