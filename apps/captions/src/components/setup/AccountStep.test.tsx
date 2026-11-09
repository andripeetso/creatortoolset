import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AccountStepView, parseProviders, type AccountState, type Provider } from "./AccountStep";

const all: Provider[] = ["apple", "google", "github"];
const view = (account: AccountState, providers: Provider[] = all) =>
  renderToStaticMarkup(<AccountStepView account={account} busy={false} providers={providers} onSignIn={() => {}} onDone={() => {}} />);

it("asks for Apple, Google or GitHub and can't be passed until signed in", () => {
  for (const s of [{ state: "signedOut" }, { state: "cancelled" }, { state: "error", message: "Can't reach the server" }] as AccountState[]) {
    const html = view(s);
    expect(html).toContain("Continue with Apple");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain(">Continue<");
  }
  expect(view({ state: "error", message: "Can't reach the server" })).toContain("Can&#x27;t reach the server");
  expect(view({ state: "checking" })).not.toContain(">Continue<");
});

it("shows a button only for the providers the account server has keys for", () => {
  const html = view({ state: "signedOut" }, ["github"]);
  expect(html).toContain("Continue with GitHub");
  expect(html).not.toContain("Continue with Apple");
  expect(html).not.toContain("Continue with Google");
  expect(parseProviders("google,github,microsoft")).toEqual(["google", "github"]);
  expect(parseProviders("")).toEqual([]);
});

it("shows no sign-in button when the reply names no providers (an older Mac app)", () => {
  const html = view({ state: "signedOut" }, []);
  expect(html).not.toContain("Continue with");
  expect(html).toContain("Sign in to set up your account");
});

it("goes on once signed in, while the server has no sign-in yet, or with no account step", () => {
  const signed = view({ state: "signedIn", name: "Sam Tiny", email: "sam@tinyacrobatics.com" });
  expect(signed).toContain("Signed in as Sam Tiny (sam@tinyacrobatics.com)");
  expect(signed).not.toContain("Continue with Apple");
  expect(signed).toContain(">Continue<");
  const notYet = view({ state: "notSetUp", server: "creatortoolset.com" });
  expect(notYet).toContain("Sign-in isn&#x27;t set up on creatortoolset.com yet");
  expect(notYet).toContain(">Continue<");
  expect(view({ state: "off" })).toContain(">Continue<");
  // offline on the first run: never stuck on a step that can't be passed
  const offline = view({ state: "unreachable", server: "creatortoolset.com" });
  expect(offline).toContain("Can&#x27;t reach creatortoolset.com");
  expect(offline).toContain(">Continue<");
});
