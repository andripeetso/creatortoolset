// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuth, type Me } from "@/lib/auth";

// Settings → Account as each person meets it: the owner of the server on their Mac, who made no account, and someone
// who signs in to a server with a password of their own.

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
const { AccountSection, accountWays } = await import("./AccountSection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let account: Record<string, unknown>;
let providers: Record<string, boolean>;
beforeEach(() => {
  providers = { apple: false, google: false, github: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = String(url).startsWith("/api/account/providers") ? providers : String(url).startsWith("/api/auth/account") ? account : {};
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }),
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  delete (window as { webkit?: unknown }).webkit;
});

const me = (more: Partial<Me>): Me => ({ username: "admin", role: "admin", cloud: true, off: [], ...more });
/** The Mac app's account bridge, answering every question with `reply`. */
const macApp = (reply: Record<string, string>) => {
  (window as { webkit?: unknown }).webkit = { messageHandlers: { account: { postMessage: async () => reply } } };
};
const show = async () => {
  act(() =>
    root.render(
      <MemoryRouter>
        <AccountSection />
      </MemoryRouter>,
    ),
  );
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
};
const text = () => document.body.textContent ?? "";

it("the owner of the server on their Mac sees their name and the app's account, and nothing they never made", async () => {
  // the Mac app made the account ("admin") and its password; the person's name is their Mac's or their account's
  useAuth.setState({ required: true, kind: "mac", me: me({ name: "Tiny Sam", noPassword: true }) });
  account = { username: "admin", name: "", login: "admin", identities: [], signins: [], picture: null };
  macApp({ state: "signedOut", providers: "google,apple,github" });
  await show();
  expect(text()).toContain("Tiny Sam");
  expect(text()).not.toContain("admin");
  for (const never of ["Sign-in name", "Password", "Sign-in code", "Sign out", "Session", "Sign-ins"]) expect(text()).not.toContain(never);
  // the app's own account: one row, signed out, with the sign-ins the app offers
  expect(text()).toContain("Creator Toolset account");
  expect(text()).toContain("Not signed in");
  expect([...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")).filter(Boolean)).toEqual(
    expect.arrayContaining(["Sign in with Google", "Sign in with Apple", "Sign in with GitHub"]),
  );
});

it("signed in to the app's account: who it is, once, with no provider rows", async () => {
  useAuth.setState({ required: true, kind: "mac", me: me({ name: "Tiny Sam", noPassword: true }) });
  account = { username: "admin", name: "", login: "admin", identities: [], signins: [], picture: null };
  macApp({ state: "signedIn", name: "Tiny Sam", email: "sam@tinyacrobatics.com", provider: "google", logins: "", providers: "google,apple,github" });
  await show();
  expect(text()).toContain("sam@tinyacrobatics.com");
  expect(text()).not.toContain("Not signed in");
  expect(document.querySelector('[aria-label="Sign in with Google"]')).toBeNull();
  expect(document.querySelector('[aria-label="Creator Toolset account actions"]')).not.toBeNull();
});

it("someone with a password of their own on a server keeps the sign-in name, the password, its code and Sign out", async () => {
  useAuth.setState({ required: true, kind: "server", me: me({ username: "sam", name: "Sam" }) });
  account = { username: "sam", name: "Sam", login: "sam", identities: ["google"], signins: [{ provider: "google", email: "sam@tinyacrobatics.com", name: "Sam", picture: null }], picture: null };
  providers = { apple: true, google: true, github: false };
  await show();
  for (const row of ["Sign-in name", "Password", "Sign-in code", "Sign-ins", "Session", "Sign out"]) expect(text()).toContain(row);
  // in a browser there is no Mac app, so no account of its own
  expect(text()).not.toContain("Creator Toolset account");
});

it("in the Mac app, a server that takes the Creator Toolset account shows that account and no Sign-ins list of its own", async () => {
  useAuth.setState({ required: true, kind: "server", me: me({ username: "sam", name: "Sam", noPassword: true }) });
  account = { username: "sam", name: "Sam", login: "sam", identities: ["google", "apple"], signins: [{ provider: "google", email: "sam@tinyacrobatics.com", name: "Sam", picture: null }, { provider: "apple", email: "sam@tinyacrobatics.com", name: "", picture: null }], picture: null };
  providers = { apple: true, google: true, github: true, account: true };
  macApp({ state: "signedIn", name: "Sam", email: "sam@tinyacrobatics.com", provider: "google", logins: "", providers: "google,apple,github" });
  await show();
  expect(text()).toContain("Creator Toolset account");
  expect(text()).not.toContain("Sign-ins");
  // the account was made with Google; Apple is one this server has for the person: both are its ways in
  expect(text()).toContain("Google · Apple");
  // the server's own sign-in can go from here, the one the account was made with can not
  expect(accountWays("google", [], ["google", "apple"])).toEqual({ ways: ["google", "apple"], droppable: ["apple"] });
  expect(accountWays("google", ["github"], ["google"])).toEqual({ ways: ["google", "github"], droppable: ["github"] });
});

it("a server with sign-ins of its own (no account service) keeps its Sign-ins list beside the Mac app's account", async () => {
  useAuth.setState({ required: true, kind: "server", me: me({ username: "sam", name: "Sam" }) });
  account = { username: "sam", name: "Sam", login: "sam", identities: ["google"], signins: [{ provider: "google", email: "sam@tinyacrobatics.com", name: "Sam", picture: null }], picture: null };
  providers = { apple: false, google: true, github: false };
  macApp({ state: "signedOut", providers: "google,apple,github" });
  await show();
  expect(text()).toContain("Sign-ins");
  expect(text()).toContain("Creator Toolset account");
});
