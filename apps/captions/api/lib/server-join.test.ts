import { describe, expect, it } from "vitest";
import { joinServer, parseJoinLink } from "./server-join";

const CODE = "a".repeat(43); // a base64url code of the length the server mints
const LINK = `https://studio.example.com/api/auth/link/${CODE}`;

/** A fake of the other server: the link answers `link`, and the device POST answers `device`. */
function fakeServer(link: Response | (() => Response), device: Response | (() => Response)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const pick = String(url).includes("/api/devices") ? device : link;
    return typeof pick === "function" ? pick() : pick.clone();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const signedIn = () =>
  new Response(null, { status: 302, headers: [["location", "/"], ["set-cookie", "ct_session=abc123; HttpOnly; Path=/; SameSite=Lax"]] });
const added = () => Response.json({ device: { id: "dev_1", name: "Workshop PC" }, token: "ctd_secret" });

describe("parseJoinLink: only a sign-in link of another server", () => {
  it("accepts an https link and keeps its origin and path", () => {
    expect(parseJoinLink(` ${LINK} `)).toEqual({ origin: "https://studio.example.com", url: LINK });
  });

  it("accepts plain http only on this network", () => {
    expect(parseJoinLink(`http://studio-mac.local:3000/api/auth/link/${CODE}`)).not.toBeNull();
    expect(parseJoinLink(`http://tiny-acrobatics.local:3000/api/auth/link/${CODE}`)).not.toBeNull();
    expect(parseJoinLink(`http://studio.example.com/api/auth/link/${CODE}`)).toBeNull();
  });

  it("refuses other schemes, other paths, queries, credentials and short codes", () => {
    expect(parseJoinLink(`ftp://studio.example.com/api/auth/link/${CODE}`)).toBeNull();
    expect(parseJoinLink(`https://studio.example.com/api/devices`)).toBeNull();
    expect(parseJoinLink(`https://studio.example.com/api/auth/link/${CODE}/extra`)).toBeNull();
    expect(parseJoinLink(`${LINK}?next=https://evil.example`)).toBeNull();
    expect(parseJoinLink(`${LINK}#x`)).toBeNull();
    expect(parseJoinLink(`https://user:pw@studio.example.com/api/auth/link/${CODE}`)).toBeNull();
    expect(parseJoinLink("https://studio.example.com/api/auth/link/short")).toBeNull();
    expect(parseJoinLink("studio.example.com/api/auth/link/" + CODE)).toBeNull();
    expect(parseJoinLink(42)).toBeNull();
  });
});

describe("joinServer", () => {
  it("refuses a link that is not one before any request is made", async () => {
    const { fetchImpl, calls } = fakeServer(signedIn(), added());
    const r = await joinServer("https://studio.example.com/api/devices", { fetchImpl });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("opens the link once without following redirects, then adds the computer with the cookie it was given", async () => {
    const { fetchImpl, calls } = fakeServer(signedIn(), added());
    const r = await joinServer(LINK, { fetchImpl, name: "Workshop PC" });
    expect(r).toEqual({ ok: true, server: "https://studio.example.com", device: { id: "dev_1", name: "Workshop PC" }, token: "ctd_secret" });
    expect(calls[0]!.url).toBe(LINK);
    expect(calls[0]!.init?.redirect).toBe("manual");
    expect(calls[1]!.url).toBe("https://studio.example.com/api/devices");
    expect(calls[1]!.init?.redirect).toBe("manual");
    expect((calls[1]!.init?.headers as Record<string, string>).cookie).toBe("ct_session=abc123");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ name: "Workshop PC" });
  });

  it("shows the other server's own refusal words when the link is expired or was used", async () => {
    const gone = () => new Response("This sign-in link has expired or was used. Ask for a new one.", { status: 410 });
    const r = await joinServer(LINK, { fetchImpl: fakeServer(gone, added()).fetchImpl });
    expect(r).toEqual({ ok: false, message: "This sign-in link has expired or was used. Ask for a new one." });
  });

  it("shows the password refusal from a server that asks for one first", async () => {
    const refused = () => new Response("Set a password on the Mac first: the Mac app's This Mac → Access from other devices", { status: 403 });
    const r = await joinServer(LINK, { fetchImpl: fakeServer(refused, added()).fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Set a password on the Mac first");
  });

  it("fails when the link answers without signing anyone in", async () => {
    const r = await joinServer(LINK, { fetchImpl: fakeServer(new Response(null, { status: 302 }), added()).fetchImpl });
    expect(r.ok).toBe(false);
  });

  it("fails when the server refuses to add the computer, and never returns a token", async () => {
    const refusedDevice = () => Response.json({ error: "Not for guests" }, { status: 403 });
    const r = await joinServer(LINK, { fetchImpl: fakeServer(signedIn(), refusedDevice).fetchImpl });
    expect(r).toEqual({ ok: false, message: "Not for guests" });
    const noToken = () => Response.json({ device: { id: "dev_1" } });
    expect((await joinServer(LINK, { fetchImpl: fakeServer(signedIn(), noToken).fetchImpl })).ok).toBe(false);
  });

  it("fails cleanly when the server can't be reached", async () => {
    const boom = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const r = await joinServer(LINK, { fetchImpl: boom });
    expect(r.ok).toBe(false);
  });
});
